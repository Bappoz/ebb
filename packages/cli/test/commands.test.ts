import { describe, expect, it } from 'vitest';
import { SqliteStore } from '@ebb/store';
import { deploy, list, versions } from '../src/commands.js';

/** Um processo válido e sem aviso: início → tarefa → fim. */
const PEDIDO = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Pedido" name="Processo de Pedido" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Separar" name="Separar itens" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Separar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Separar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

/** Mesma coisa, com um nome diferente na tarefa: conteúdo novo. */
const PEDIDO_V2 = PEDIDO.replace('Separar itens', 'Separar e conferir');

/** Sem evento de início: erro de validação. */
const SEM_INICIO = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Quebrado" isExecutable="true">
    <bpmn:task id="Solta" />
  </bpmn:process>
</bpmn:definitions>`;

/** Válido, mas com um nó sem saída: aviso, não erro. */
const COM_AVISO = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Avisado" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:task id="BecoSemSaida" name="Beco sem saída" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="BecoSemSaida" />
    <bpmn:sequenceFlow id="f1" sourceRef="Start" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

/** Primeiro pool é caixa-preta: o executável é o segundo. */
const COLABORACAO = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:collaboration id="Colab">
    <bpmn:participant id="PartCliente" name="Cliente" processRef="Cliente" />
    <bpmn:participant id="PartLoja" name="Loja" processRef="Loja" />
  </bpmn:collaboration>
  <bpmn:process id="Cliente" isExecutable="false" />
  <bpmn:process id="Loja" name="Loja" isExecutable="true">
    <bpmn:startEvent id="L1" />
    <bpmn:task id="Atender" />
    <bpmn:endEvent id="L2" />
    <bpmn:sequenceFlow id="l1" sourceRef="L1" targetRef="Atender" />
    <bpmn:sequenceFlow id="l2" sourceRef="Atender" targetRef="L2" />
  </bpmn:process>
</bpmn:definitions>`;

function store(): SqliteStore {
  return new SqliteStore({ path: ':memory:', now: () => new Date('2026-09-14T10:00:00Z') });
}

describe('deploy', () => {
  it('publica um diagrama válido como v1', async () => {
    const db = store();
    const result = await deploy(db, PEDIDO, { source: '/tmp/pedido.bpmn' });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('publicado: Processo de Pedido (Pedido) v1');
    expect((await db.read('Pedido'))?.source).toBe('pedido.bpmn');
    db.close();
  });

  it('republicar o mesmo arquivo diz que nada mudou', async () => {
    const db = store();
    await deploy(db, PEDIDO);
    const again = await deploy(db, PEDIDO);

    expect(again.exitCode).toBe(0);
    expect(again.output).toContain('sem mudança');
    expect(await db.versions('Pedido')).toHaveLength(1);
    db.close();
  });

  it('conteúdo alterado vira v2', async () => {
    const db = store();
    await deploy(db, PEDIDO);
    const second = await deploy(db, PEDIDO_V2);

    expect(second.output).toContain('v2');
    db.close();
  });

  it('recusa um diagrama com erro de validação', async () => {
    const db = store();
    const result = await deploy(db, SEM_INICIO);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('nada publicado');
    expect(result.output).toContain('no start event');
    expect(await db.listProcesses()).toEqual([]);
    db.close();
  });

  it('recusa XML que nem é BPMN', async () => {
    const db = store();
    const result = await deploy(db, '<isto-nao-e-bpmn>');

    expect(result.exitCode).toBe(1);
    expect(await db.listProcesses()).toEqual([]);
    db.close();
  });

  it('segura um aviso até alguém dizer --force', async () => {
    const db = store();
    const refused = await deploy(db, COM_AVISO);
    expect(refused.exitCode).toBe(1);
    expect(refused.output).toContain('--force');
    expect(await db.listProcesses()).toEqual([]);

    const forced = await deploy(db, COM_AVISO, { force: true });
    expect(forced.exitCode).toBe(0);
    expect(forced.output).toContain('publicado com');
    expect(await db.listProcesses()).toHaveLength(1);
    db.close();
  });

  it('publica o pool executável, não o primeiro declarado', async () => {
    const db = store();
    // A colaboração avisa que um pool não roda, então precisa de --force.
    const result = await deploy(db, COLABORACAO, { force: true });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('(Loja) v1');
    db.close();
  });

  it('recusa uma colaboração com mais de um pool executável', async () => {
    const db = store();
    const dois = COLABORACAO.replace(
      'id="Cliente" isExecutable="false" />',
      `id="Cliente" name="Cliente" isExecutable="true">
    <bpmn:startEvent id="C1" />
    <bpmn:task id="Pedir" />
    <bpmn:endEvent id="C2" />
    <bpmn:sequenceFlow id="c1" sourceRef="C1" targetRef="Pedir" />
    <bpmn:sequenceFlow id="c2" sourceRef="Pedir" targetRef="C2" />
  </bpmn:process>`,
    );

    // Nem com --force: escolher um pool e ignorar o outro não é uma opção.
    const result = await deploy(db, dois, { force: true });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('2 pools executáveis (Cliente, Loja)');
    expect(await db.listProcesses()).toEqual([]);
    db.close();
  });
});

describe('ls', () => {
  it('diz o que fazer quando não há nada', async () => {
    const db = store();
    const result = await list(db);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('ebb deploy');
    db.close();
  });

  it('mostra uma linha por processo, com a versão atual', async () => {
    const db = store();
    await deploy(db, PEDIDO, { source: 'pedido.bpmn' });
    await deploy(db, PEDIDO_V2, { source: 'pedido.bpmn' });
    const result = await list(db);

    expect(result.output).toContain('PROCESSO');
    expect(result.output).toContain('Processo de Pedido');
    expect(result.output).toContain('v2');
    expect(result.output).toContain('2 versões');
    expect(result.output).toContain('pedido.bpmn');
    db.close();
  });

  it('conta uma versão no singular', async () => {
    const db = store();
    await deploy(db, PEDIDO);
    expect((await list(db)).output).toContain('1 versão');
    db.close();
  });
});

describe('versions', () => {
  it('lista o histórico, mais novo primeiro', async () => {
    const db = store();
    await deploy(db, PEDIDO);
    await deploy(db, PEDIDO_V2);
    const result = await versions(db, 'Pedido');

    expect(result.exitCode).toBe(0);
    const lines = result.output.split('\n');
    expect(lines[0]).toContain('VERSÃO');
    expect(lines[1]).toContain('v2');
    expect(lines[2]).toContain('v1');
    db.close();
  });

  it('avisa quando a chave não existe', async () => {
    const db = store();
    const result = await versions(db, 'NaoExiste');

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('NaoExiste');
    db.close();
  });
});
