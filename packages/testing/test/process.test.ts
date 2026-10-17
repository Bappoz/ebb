import { BpmnError } from '@bpmn-flow/core';
import { afterEach, describe, expect, it } from 'vitest';
import { testProcess, type ProcessTest } from '../src/process.js';
import { ebbMatchers, installEbbMatchers } from '../src/vitest.js';
import { GATEWAY, JOB, JOB_WITH_BOUNDARY, SIGNAL, TIMER } from './fixtures.js';

installEbbMatchers(expect);

const open: ProcessTest[] = [];
afterEach(() => {
  for (const process of open) process.close();
  open.length = 0;
});

async function fixture(xml: string, options?: Parameters<typeof testProcess>[1]) {
  const process = await testProcess(xml, options);
  open.push(process);
  return process;
}

describe('caminho e cobertura', () => {
  it('afirma nós e fluxos visitados', async () => {
    const process = await fixture(GATEWAY);
    const run = await process.start();
    await run.complete('Avaliar', { valor: 150 });

    expect(run).toHaveVisited('Gateway');
    expect(run).toHaveVisited('Diretoria');
    expect(run).not.toHaveVisited('EndBaixo');
    expect(run).toHaveTaken('Flow_Alto');
    expect(run).not.toHaveTaken('Flow_Baixo');
    expect(run.visitedNodes).toContain('Diretoria');

    expect(ebbMatchers.toHaveVisited(run, 'Diretoria').message()).toContain('não tivesse visitado');
    expect(ebbMatchers.toHaveTaken(run, 'Flow_Alto').message()).toContain('não tivesse tomado');
  });

  it('agrega cenários e chega a 100% dos sequence flows', async () => {
    const process = await fixture(GATEWAY);

    const high = await process.start();
    await high.complete('Avaliar', { valor: 150 });
    await high.complete('Diretoria');

    const low = await process.start();
    await low.complete('Avaliar', { valor: 50 });

    expect(process.coverage()).toMatchObject({ total: 5, covered: 5, missing: [] });
    expect(process.coverage()).toHaveFullFlowCoverage();
    expect(ebbMatchers.toHaveFullFlowCoverage(process.coverage()).message()).toContain(
      'não estivesse completa',
    );
  });

  it('a falha de cobertura nomeia o fluxo e suas pontas', async () => {
    const process = await fixture(GATEWAY);
    const high = await process.start();
    await high.complete('Avaliar', { valor: 150 });

    const result = ebbMatchers.toHaveFullFlowCoverage(process.coverage());
    expect(result.pass).toBe(false);
    expect(result.message()).toContain('Flow_Baixo: Gateway → EndBaixo');
  });
});

describe('dublês de worker', () => {
  it('percorre activate/complete de produção e journala o resultado', async () => {
    const seen: unknown[] = [];
    const process = await fixture(JOB, {
      workers: {
        charge: (job) => {
          seen.push(job.variables);
          return { charged: true };
        },
      },
    });

    const run = await process.start({ variables: { total: 42 } });

    expect(seen).toEqual([{ total: 42 }]);
    expect(run.tasks).toMatchObject([{ nodeId: 'Review' }]);
    expect(run.snapshot.variables).toMatchObject({ charged: true });
    expect(await run.journal()).toMatchObject([
      { type: 'start' },
      { type: 'completeJob', payload: { output: { charged: true } } },
    ]);
  });

  it('permite registrar o worker depois que a execução já parou no job', async () => {
    const process = await fixture(JOB);
    const run = await process.start();

    await expect(run.complete('Charge')).rejects.toThrow('é um job');
    run.worker('charge', () => undefined);
    await run.runWorkers();

    expect(run.tasks).toMatchObject([{ nodeId: 'Review' }]);
  });

  it('um dublê do cenário sobrescreve o dublê da fixture', async () => {
    const process = await fixture(JOB, {
      workers: { charge: () => ({ source: 'fixture' }) },
    });
    const run = await process.start({ workers: { charge: () => ({ source: 'scenario' }) } });

    expect(run.snapshot.variables).toMatchObject({ source: 'scenario' });
  });

  it('saída inválida de worker vira falha técnica', async () => {
    const process = await fixture(JOB, {
      workers: { charge: () => [] as unknown as Record<string, unknown> },
    });
    const run = await process.start();

    expect(run.incidents[0]?.message).toContain('deve devolver um objeto ou undefined');
  });

  it('normaliza uma exceção que não é Error', async () => {
    const process = await fixture(JOB, {
      workers: {
        // Exercita a normalização defensiva de integrações JS malcomportadas.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        charge: () => Promise.reject('offline'),
      },
    });
    const run = await process.start();

    expect(run.incidents).toMatchObject([{ message: 'offline' }]);
  });

  it('uma falha técnica usa retry e termina em incidente', async () => {
    let attempts = 0;
    const process = await fixture(JOB, {
      workers: {
        charge: () => {
          attempts += 1;
          throw new Error('gateway timeout');
        },
      },
    });

    const run = await process.start({ engine: { retry: { attempts: 1 } } });

    expect(attempts).toBe(2);
    expect(run.incidents).toMatchObject([{ message: 'gateway timeout', attempts: 2 }]);
    expect((await run.journal()).map((entry) => entry.type)).toEqual([
      'start',
      'failJob',
      'failJob',
    ]);
  });

  it('BpmnError toma o boundary de negócio sem abrir incidente', async () => {
    const process = await fixture(JOB_WITH_BOUNDARY, {
      workers: { charge: () => Promise.reject(new BpmnError('DECLINED', 'card declined')) },
    });

    const run = await process.start();

    expect(run.snapshot.status).toBe('completed');
    expect(run.incidents).toEqual([]);
    expect(run).toHaveVisited('Declined');
    expect(run).not.toHaveVisited('Paid');
    expect(run).toHaveTaken('f2');
  });
});

describe('relógio no cenário', () => {
  it('advanceTo dispara timer sem esperar o relógio real', async () => {
    const at = Date.parse('2026-01-01T00:00:00.000Z');
    const process = await fixture(TIMER, { at });
    const run = await process.start();

    expect(run.tasks).toMatchObject([{ nodeId: 'Aguardar' }]);
    await run.advanceTo(at + 60 * 60 * 1_000);

    expect(run.tasks).toMatchObject([{ nodeId: 'Conferir' }]);
    expect((await run.journal()).at(-1)).toMatchObject({ type: 'tick', at: at + 3_600_000 });
  });

  it('advanceBy e tick usam o relógio controlado', async () => {
    const process = await fixture(TIMER, { at: 0 });
    const run = await process.start();

    await run.tick();
    expect(run.tasks).toMatchObject([{ nodeId: 'Aguardar' }]);
    await run.advanceBy(3_600_000);
    expect(run.tasks).toMatchObject([{ nodeId: 'Conferir' }]);
  });
});

describe('comandos legíveis', () => {
  it('aceita tokenId e explica quando a tarefa pedida não está pendente', async () => {
    const process = await fixture(GATEWAY);
    const run = await process.start();
    const tokenId = run.tasks[0]?.tokenId ?? '';

    await expect(run.complete('Outra')).rejects.toThrow('Pendentes: Avaliar');
    await run.complete(tokenId, { valor: 50 });
    await expect(run.complete('Outra')).rejects.toThrow('Nenhuma tarefa pendente');
  });

  it('entrega sinais e suas variáveis', async () => {
    const process = await fixture(SIGNAL);
    const run = await process.start();

    await run.signal('approved', { approvedBy: 'ana' });

    expect(run.snapshot.status).toBe('completed');
    expect(run.snapshot.variables).toMatchObject({ approvedBy: 'ana' });
  });
});
