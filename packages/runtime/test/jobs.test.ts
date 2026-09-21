import { checksumOf, SqliteStore } from '@ebb/store';
import { describe, expect, it } from 'vitest';
import { EbbRuntime, type CommandResult, type StartOptions } from '../src/runtime.js';
import { EXTERNAL_JOB } from './fixtures.js';

const AT = 1_700_000_000_000;

/**
 * Uma instância do fluxo com job externo, já parada no worker `charge`.
 *
 * O relógio é mutável (`advance`) porque um teste de lease precisa avançá-lo
 * além do vencimento para provar que o job volta a ser candidato — travado
 * numa hora fixa, a segunda ativação nunca encontraria nada.
 */
async function startOnJob(engine?: StartOptions['engine']): Promise<{
  store: SqliteStore;
  runtime: EbbRuntime;
  started: CommandResult;
  advance: (ms: number) => void;
}> {
  let at = AT;
  const store = new SqliteStore({ path: ':memory:', now: () => new Date(at) });
  await store.deploy({ processKey: 'P', xml: EXTERNAL_JOB, checksum: checksumOf(EXTERNAL_JOB) });
  let ids = 0;
  const runtime = new EbbRuntime({
    store,
    now: () => new Date(at),
    newId: () => `inst-${++ids}`,
  });
  const started = await runtime.start('P', { variables: { pedido: 42 }, engine });
  return { store, runtime, started, advance: (ms) => (at += ms) };
}

describe('jobs no runtime', () => {
  it('a instância que para num job já nasce com a linha de job', async () => {
    const { store, started } = await startOnJob();
    expect(await store.listJobs()).toMatchObject([
      { instanceId: started.instance.id, type: 'charge', state: 'pending', attempts: 0 },
    ]);
    store.close();
  });

  it('ativar trava sem journalar', async () => {
    const { runtime, store, started } = await startOnJob();

    const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    expect(job).toMatchObject({ state: 'locked', worker: 'w1', variables: { pedido: 42 } });
    // Travar não é evento de negócio: para a instância, nada aconteceu.
    expect((await store.journal(started.instance.id)).length).toBe(1);
    store.close();
  });

  it('concluir journala e apaga a linha', async () => {
    const { runtime, store, started } = await startOnJob();
    const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    const result = await runtime.completeJob(job!.instanceId, job!.tokenId, { ok: true });

    expect(result.snapshot.status).toBe('completed');
    expect(await store.listJobs()).toHaveLength(0);
    expect((await store.journal(started.instance.id)).at(-1)).toMatchObject({
      type: 'completeJob',
      payload: { tokenId: job!.tokenId, output: { ok: true } },
    });
    store.close();
  });

  it('falhar com retry devolve o job com attempts maior', async () => {
    const { runtime, store } = await startOnJob({ retry: { attempts: 1 } });
    const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    await runtime.failJob(
      job!.instanceId,
      job!.tokenId,
      { message: 'gateway timeout' },
      { worker: 'w1' },
    );

    // O motor retenta na hora (mesmo token, sem esperar tick): o job segue
    // parado como 'job', não vira incidente, e `attempts` sobe para 1 — sem
    // isso o worker que pegar a próxima tentativa não saberia que já houve
    // uma falha. `failJob` libera a trava do worker que acabou de reportar
    // (ele já disse o que tinha a dizer sobre esta tentativa e não vai
    // pedir por este job de novo, e provou quem é passando `worker: 'w1'`);
    // sem isso a reconciliação preservaria a trava do worker anterior —
    // certo quando o job só continua parado sem ninguém ter falado nada,
    // errado aqui — e um retry sem `delay` ("tenta de novo agora") viraria
    // um backoff do lease inteiro (60s por padrão) antes de qualquer worker
    // poder pegá-lo de volta.
    const [reverted] = await store.listJobs();
    expect(reverted).toMatchObject({ state: 'pending', attempts: 1 });
    expect(reverted?.worker).toBeUndefined();
    store.close();
  });

  it('falhar sem informar o worker não libera a trava — confia só no lease', async () => {
    // Quem não sabe dizer quem é não provou que segura o job; liberar no
    // palpite dele reabriria o buraco do fencing. Sem `options.worker`, o
    // comportamento cai para o mesmo backstop de sempre: o lease.
    const { runtime, store } = await startOnJob({ retry: { attempts: 1 } });
    const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    await runtime.failJob(job!.instanceId, job!.tokenId, { message: 'gateway timeout' });

    expect(await store.listJobs()).toMatchObject([{ state: 'locked', worker: 'w1', attempts: 1 }]);
    store.close();
  });

  it('um release que lança não faz failJob rejeitar', async () => {
    // Melhor esforço: o journal já commitou o desfecho real do comando antes
    // do release ser sequer tentado. Se isto propagasse, um worker que vê
    // failJob() rejeitar tentaria de novo e aplicaria o comando uma segunda
    // vez — consumindo mais uma tentativa do orçamento de retry à toa, ou
    // abrindo um incidente que não deveria existir.
    class ReleaseThrows extends SqliteStore {
      override releaseJob(): Promise<void> {
        return Promise.reject(new Error('SQLITE_BUSY'));
      }
    }
    const store = new ReleaseThrows({ path: ':memory:', now: () => new Date(AT) });
    await store.deploy({ processKey: 'P', xml: EXTERNAL_JOB, checksum: checksumOf(EXTERNAL_JOB) });
    const runtime = new EbbRuntime({ store, now: () => new Date(AT), newId: () => 'inst-1' });
    await runtime.start('P', { variables: { pedido: 42 }, engine: { retry: { attempts: 1 } } });
    const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    await expect(
      runtime.failJob(
        job!.instanceId,
        job!.tokenId,
        { message: 'gateway timeout' },
        { worker: 'w1' },
      ),
    ).resolves.toMatchObject({ snapshot: { status: 'waiting' } });
    store.close();
  });

  it('failJob de um worker que já perdeu a trava não derruba a de quem tomou o job', async () => {
    // O regresso do finding 2: w1 trava, estoura o lease, w2 legitimamente
    // toma o mesmo job; só depois w1 reporta a falha antiga. Sem o fencing
    // por worker no `UPDATE`, o release de w1 apagaria a trava de w2 — e um
    // w3 poderia pegar o job que w2 ainda está trabalhando.
    const { runtime, store, advance } = await startOnJob({ retry: { attempts: 1 } });
    const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    advance(60_001);
    const [retaken] = await runtime.activateJobs({ type: 'charge', worker: 'w2' });
    expect(retaken).toMatchObject({ tokenId: job!.tokenId, worker: 'w2' });

    await runtime.failJob(
      job!.instanceId,
      job!.tokenId,
      { message: 'gateway timeout, relatado tarde por w1' },
      { worker: 'w1' },
    );

    expect(await store.listJobs()).toMatchObject([{ state: 'locked', worker: 'w2', attempts: 1 }]);
    store.close();
  });

  it('falhar sem retry deixa incidente e nenhum job', async () => {
    const { runtime, store } = await startOnJob();
    const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    await runtime.failJob(
      job!.instanceId,
      job!.tokenId,
      { message: 'gateway timeout' },
      { worker: 'w1' },
    );

    expect(await store.listJobs()).toHaveLength(0);
    const view = await runtime.inspect(job!.instanceId);
    expect(view.tasks).toMatchObject([{ reason: 'incident' }]);
    store.close();
  });

  it('job abandonado não deixa rastro no journal', async () => {
    const { runtime, store, started } = await startOnJob();
    await runtime.activateJobs({ type: 'charge', worker: 'w1', lease: 1 });

    expect((await store.journal(started.instance.id)).length).toBe(1);
    store.close();
  });

  it('a trava vencida devolve o job, mesmo sem ninguém reportar nada', async () => {
    // O backstop para o worker que morre segurando o job, sem nunca chamar
    // completeJob nem failJob: o lease, não um reporte, é quem devolve o
    // job aqui. Avança 1ms além do lease de 60s (não exatamente 60s) para
    // testar o vencimento em si, não a borda `now === until` — essa borda já
    // tem teste próprio no store.
    const { runtime, store, advance } = await startOnJob();
    const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    advance(60_001);
    const retaken = await runtime.activateJobs({ type: 'charge', worker: 'w2' });

    expect(retaken).toMatchObject([{ tokenId: job!.tokenId, worker: 'w2' }]);
    store.close();
  });

  it('falhar com retry devolve o job à fila sem esperar o lease vencer', async () => {
    // A propriedade de que o worker da tarefa 9 depende: um retry sem
    // `delay` configurado é "tenta de novo agora", não "espera o lease
    // inteiro" — nenhuma chamada a `advance` aqui. O job volta à fila, sem
    // afinidade por worker: quem pega de volta é w2, não w1.
    const { runtime, store } = await startOnJob({ retry: { attempts: 1 } });
    const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    await runtime.failJob(
      job!.instanceId,
      job!.tokenId,
      { message: 'gateway timeout' },
      { worker: 'w1' },
    );
    const [retaken] = await runtime.activateJobs({ type: 'charge', worker: 'w2' });

    expect(retaken).toMatchObject({ tokenId: job!.tokenId, worker: 'w2', attempts: 1 });
    expect(await store.listJobs()).toMatchObject([{ state: 'locked', worker: 'w2' }]);
    store.close();
  });

  it('a política de retry sobrevive ao re-hidratar que cada apply faz', async () => {
    // O ponto inteiro do chunk: sem hydrate() repassar onHandlerError/retry a
    // restore(), a segunda falha voltaria ao padrão 'fail' de
    // @bpmn-flow/core, sem retry algum, e derrubaria a instância — cada
    // apply() descarta o motor e o reconstrói do zero, então isto só prova
    // alguma coisa se as duas falhas passarem por hydrate()s distintos.
    const { runtime, store } = await startOnJob({ retry: { attempts: 1 } });

    const [first] = await runtime.activateJobs({ type: 'charge', worker: 'w1' });
    const afterFirstFailure = await runtime.failJob(
      first!.instanceId,
      first!.tokenId,
      { message: 'gateway timeout' },
      { worker: 'w1' },
    );
    // Primeira falha: dentro do orçamento de 1 retry, então nenhum incidente
    // — o motor retentou na hora e o job já está disponível de novo (a
    // trava foi liberada, sem precisar esperar o lease vencer).
    expect(afterFirstFailure.incidents).toHaveLength(0);
    expect(afterFirstFailure.snapshot.status).toBe('waiting');

    const [second] = await runtime.activateJobs({ type: 'charge', worker: 'w2' });
    expect(second).toMatchObject({ tokenId: first!.tokenId, attempts: 1 });

    const afterSecondFailure = await runtime.failJob(
      second!.instanceId,
      second!.tokenId,
      { message: 'gateway timeout again' },
      { worker: 'w2' },
    );
    // Orçamento esgotado: incidente aberto, instância ainda viva (não 'failed').
    expect(afterSecondFailure.incidents).toMatchObject([{ message: 'gateway timeout again' }]);
    expect(afterSecondFailure.snapshot.status).toBe('waiting');
    expect(await store.listJobs()).toHaveLength(0);
    store.close();
  });
});
