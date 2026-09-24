import { randomUUID } from 'node:crypto';
import {
  ENGINE_STATE_VERSION,
  executableProcess,
  parseBpmn,
  WorkflowEngine,
} from '@bpmn-flow/core';
import type { ExecutionSnapshot, IncidentState, PendingTask } from '@bpmn-flow/core';
import type { Deployment, InstanceRecord, JobRecord, JournalEntry, Store } from '@ebb/store';
import {
  applyCommand,
  parseStartEngineOptions,
  payloadOf,
  type InstanceCommand,
  type StartEngineOptions,
} from './commands.js';
import { InstanceNotFoundError, InstanceTerminatedError } from './errors.js';
import { projectJobs } from './jobs.js';
import { replayJournal, ReplayRangeError, type ReplayStep } from './replay.js';
import { parseEngineState } from './state.js';

/** Estados de onde não se sai: comando aqui só sujaria o journal. */
const TERMINAL: ReadonlySet<string> = new Set(['completed', 'terminated', 'failed']);

export interface EbbRuntimeOptions {
  store: Store;
  /** Relógio de parede. Injetável para o teste não depender do de verdade. */
  now?: () => Date;
  /** Gerador de id, pelo mesmo motivo. */
  newId?: () => string;
}

export interface StartOptions {
  /** A versão a instanciar. A mais recente quando omitida. */
  version?: number;
  variables?: Record<string, unknown>;
  /** Políticas de falha do motor. O padrão é `incident` sem retry automático. */
  engine?: { onHandlerError?: 'fail' | 'incident'; retry?: { attempts: number } };
}

export interface CommandResult {
  instance: InstanceRecord;
  snapshot: ExecutionSnapshot;
  tasks: PendingTask[];
  /** Atividades paradas por falha, com tentativas e mensagem. */
  incidents: IncidentState[];
}

export interface InstanceView extends CommandResult {
  journal: JournalEntry[];
}

export interface ReplayView {
  instance: InstanceRecord;
  /** O XML da versão com que a instância nasceu — o que o viewer desenha. */
  xml: string;
  steps: ReplayStep[];
}

/**
 * O ciclo de vida de uma instância.
 *
 * Não guarda motor entre comandos: cada comando re-hidrata do snapshot,
 * aplica, grava e descarta. É por isso que uma instância sobrevive à morte do
 * processo sem nenhum mecanismo a mais — o caso normal e o caso do restart são
 * o mesmo caminho.
 */
export class EbbRuntime {
  private readonly store: Store;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: EbbRuntimeOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
  }

  /** Instancia um processo publicado e o leva até o primeiro ponto de espera. */
  async start(processKey: string, options: StartOptions = {}): Promise<CommandResult> {
    const deployment = await this.store.read(processKey, options.version);
    if (!deployment) {
      const what = options.version === undefined ? processKey : `${processKey} v${options.version}`;
      throw new Error(`Nada publicado com a chave "${what}".`);
    }

    const model = await parseBpmn(deployment.xml);
    const process = executableProcess(model);
    const at = this.now().getTime();

    // onHandlerError e retry: a ruling do scan pré-voo fixa o padrão do ebb
    // como 'incident' sem retry automático — diferente do padrão 'fail' de
    // @bpmn-flow/core — porque uma falha de worker deve abrir incidente, não
    // derrubar a instância. Resolvido uma única vez aqui e usado tanto para
    // construir o motor ao vivo quanto para o payload do journal: os dois
    // nunca podem divergir sobre que política a instância nasceu seguindo.
    const engineOptions: Pick<StartEngineOptions, 'onHandlerError' | 'retry'> = {
      onHandlerError: options.engine?.onHandlerError ?? 'incident',
      retry: options.engine?.retry ?? { attempts: 0 },
    };
    const engine = new WorkflowEngine(process, {
      processes: model.processes,
      now: () => at,
      ...engineOptions,
      ...(options.variables ? { variables: options.variables } : {}),
    });
    // mode, maxSteps e expressions não são passados acima — o motor nasce no
    // padrão de @bpmn-flow/core. Lemos os três de volta do próprio motor, em
    // vez de repetir esse padrão aqui, para o journal não ter uma segunda
    // fonte da verdade que possa divergir dele (é o mesmo motivo pelo qual
    // ENGINE_STATE_VERSION foi de 9 para 10: expressions passou a fazer parte
    // do estado). Sem isso, um replay a partir só do journal teria de
    // adivinhar com que opções a instância nasceu. onHandlerError e retry não
    // dá para ler de volta do motor — ele não os devolve em getState() —,
    // então entram aqui com o mesmo valor resolvido acima.
    const engineState = engine.getState();
    const command: InstanceCommand = {
      type: 'start',
      ...(options.variables ? { variables: options.variables } : {}),
      engine: {
        mode: engineState.mode,
        maxSteps: engineState.maxSteps,
        expressions: engineState.expressions,
        ...engineOptions,
      },
    };
    const snapshot = await applyCommand(engine, command);

    const instance = await this.store.createInstance({
      id: this.newId(),
      processKey: deployment.processKey,
      version: deployment.version,
      status: snapshot.status,
      command: { type: command.type, payload: payloadOf(command), at },
      state: { engineVersion: ENGINE_STATE_VERSION, json: JSON.stringify(engine.getState()) },
      jobs: projectJobs(engine),
    });

    return { instance, snapshot, tasks: engine.tasks(), incidents: engine.incidentList() };
  }

  /**
   * Aplica um comando a uma instância existente e grava o resultado.
   *
   * `at` é o relógio do motor para este comando; o padrão é o de parede. Dar um
   * explícito é como um `tick` anda até um timer vencer sem esperar.
   */
  async apply(instanceId: string, command: InstanceCommand, at?: number): Promise<CommandResult> {
    const when = at ?? this.now().getTime();
    const { instance, engine } = await this.hydrate(instanceId, when);
    if (TERMINAL.has(instance.status)) {
      throw new InstanceTerminatedError(instance.id, instance.status);
    }
    const snapshot = await applyCommand(engine, command);

    const updated = await this.store.append({
      instanceId: instance.id,
      status: snapshot.status,
      command: { type: command.type, payload: payloadOf(command), at: when },
      state: { engineVersion: ENGINE_STATE_VERSION, json: JSON.stringify(engine.getState()) },
      jobs: projectJobs(engine),
    });

    return { instance: updated, snapshot, tasks: engine.tasks(), incidents: engine.incidentList() };
  }

  /** Lê uma instância sem aplicar nada. */
  async inspect(instanceId: string): Promise<InstanceView> {
    const journal = await this.store.journal(instanceId);
    // Nada vai ler este relógio, mas restore() exige um: o último instante
    // journalado mantém a leitura determinística.
    const at = journal.at(-1)?.at ?? this.now().getTime();
    const { instance, engine } = await this.hydrate(instanceId, at, journal);
    return {
      instance,
      snapshot: engine.snapshot(),
      tasks: engine.tasks(),
      incidents: engine.incidentList(),
      journal,
    };
  }

  /**
   * Reconstrói os passos de uma instância a partir do journal. Não escreve:
   * rebobinar é leitura.
   */
  async replay(instanceId: string, upTo?: number): Promise<ReplayView> {
    const instance = await this.store.readInstance(instanceId);
    if (!instance) throw new InstanceNotFoundError(instanceId);
    const deployment = await this.deploymentOf(instance);
    const journal = await this.store.journal(instanceId);
    const { steps } = await replayJournal(
      deployment.xml,
      journal,
      upTo === undefined ? {} : { upTo },
    );
    return { instance, xml: deployment.xml, steps };
  }

  /**
   * Cria uma instância nova parada no passo `seq` de outra e, se vier,
   * aplica `command` nela.
   *
   * A bifurcação é viva: um job pendente no corte volta para a fila e um
   * worker o executa. É o "seguir com outras variáveis" do time-travel, não
   * efeito colateral. O journal da original não é tocado.
   */
  async fork(instanceId: string, seq: number, command?: InstanceCommand): Promise<CommandResult> {
    const instance = await this.store.readInstance(instanceId);
    if (!instance) throw new InstanceNotFoundError(instanceId);
    const deployment = await this.deploymentOf(instance);
    const journal = await this.store.journal(instanceId);
    const { engine, steps } = await replayJournal(deployment.xml, journal, { upTo: seq });
    const cut = steps.at(-1);
    // replayJournal já recusou seq fora de [1, último], então há ao menos um passo.
    if (!cut) throw new ReplayRangeError(seq, journal.length);

    const forked = await this.store.forkInstance({
      id: this.newId(),
      from: instance.id,
      at: seq,
      status: cut.snapshot.status,
      journal: journal.slice(0, seq),
      state: { engineVersion: ENGINE_STATE_VERSION, json: JSON.stringify(engine.getState()) },
      jobs: projectJobs(engine),
    });
    // Transação à parte de propósito: a bifurcação sem comando já é um estado
    // válido, então não há atomicidade a perder entre as duas escritas.
    if (command) return this.apply(forked.id, command);
    return { instance: forked, snapshot: cut.snapshot, tasks: cut.tasks, incidents: cut.incidents };
  }

  /**
   * Trava trabalho pendente para um worker e o devolve com as variáveis.
   *
   * Não aplica comando nenhum: travar não é evento de negócio. O que entra no
   * journal é o desfecho — `completeJob` ou `failJob`. Um job travado e nunca
   * concluído não deixa rastro na instância, que é o certo: para ela, nada
   * aconteceu, e o lease devolve o job quando vencer.
   */
  activateJobs(options: {
    type: string;
    worker: string;
    count?: number;
    lease?: number;
  }): Promise<JobRecord[]> {
    const now = this.now().getTime();
    return this.store.lockJobs({
      type: options.type,
      worker: options.worker,
      count: options.count ?? 1,
      until: now + (options.lease ?? 60_000),
      now,
    });
  }

  /** O worker terminou: conclui a atividade e segue o fluxo. */
  completeJob(
    instanceId: string,
    tokenId: string,
    output?: Record<string, unknown>,
  ): Promise<CommandResult> {
    return this.apply(instanceId, { type: 'completeJob', tokenId, ...(output ? { output } : {}) });
  }

  /**
   * O worker não conseguiu: retry, incidente ou boundary de erro, conforme o motor.
   *
   * `options.worker` é quem o chamador diz ser. Só quando informado a trava
   * é liberada — cercada pelo próprio nome no `UPDATE` do store (fencing),
   * então um `w1` atrasado que perdeu o lease para um `w2` não derruba a
   * trava legítima de `w2` ao reportar tarde. Sem `worker`, a resposta é
   * simplesmente confiar no lease: quem não sabe dizer quem é não provou que
   * segura o job, e liberar no palpite dele reabriria o mesmo buraco. O
   * worker da tarefa 9 sempre sabe o próprio nome e deve sempre passá-lo.
   */
  async failJob(
    instanceId: string,
    tokenId: string,
    error: { message: string; code?: string },
    options?: { worker?: string },
  ): Promise<CommandResult> {
    const result = await this.apply(instanceId, { type: 'failJob', tokenId, error });
    if (options?.worker) {
      // De propósito fora da transação do apply/append, e de propósito
      // melhor-esforço: o journal já commitou o desfecho real do comando, e
      // nada aqui pode mudá-lo. Um release perdido (SQLITE_BUSY, banco
      // fechado, o que for) custa no pior caso um período de lease — o
      // backstop de sempre. Propagar o erro em vez disso faria `failJob`
      // rejeitar apesar do commit, e um worker que razoavelmente tenta de
      // novo aplicaria o comando uma SEGUNDA vez — consumindo mais uma
      // tentativa do orçamento de retry, ou abrindo um incidente que não
      // deveria existir. É exatamente o "orçamento de retry se comporta mal
      // silenciosamente" que este chunk existe para evitar.
      await this.store.releaseJob(instanceId, tokenId, options.worker).catch(() => {});
    }
    return result;
  }

  /**
   * Reconstrói o motor de uma instância com o relógio congelado em `at`.
   *
   * `journal`, quando o chamador já o tem em mãos (é o caso de `inspect`),
   * evita reler do store só para pegar a primeira entrada de novo.
   */
  private async hydrate(
    instanceId: string,
    at: number,
    journal?: JournalEntry[],
  ): Promise<{ instance: InstanceRecord; engine: WorkflowEngine }> {
    const instance = await this.store.readInstance(instanceId);
    if (!instance) throw new InstanceNotFoundError(instanceId);

    const deployment = await this.deploymentOf(instance);
    const log = journal ?? (await this.store.journal(instanceId));
    const stored = await this.store.readInstanceState(instanceId);
    // Snapshot é cache: versão de motor diferente, forma inválida ou ausência
    // não tornam a instância ilegível, só mais cara — reconstrói pelo journal.
    // Quem regrava na versão atual é o próximo `apply`; ler não escreve.
    const cached =
      stored?.engineVersion === ENGINE_STATE_VERSION ? parseEngineState(stored.json) : undefined;
    const state = cached ?? (await replayJournal(deployment.xml, log)).engine.getState();

    const model = await parseBpmn(deployment.xml);
    const process = executableProcess(model);

    // As políticas de falha não estão no EngineState (o motor não as
    // serializa, nem as devolve em getState()), então quem as lembra é a
    // primeira entrada do journal — a que start() gravou. Sem re-lê-las e
    // repassá-las a restore(), toda instância re-hidratada voltaria ao padrão
    // 'fail' de @bpmn-flow/core, e uma falha de worker derrubaria a instância
    // em vez de abrir incidente.
    const [birth] = log;
    const engineOptions = parseStartEngineOptions(birth?.payload.engine);

    const engine = WorkflowEngine.restore(process, state, {
      processes: model.processes,
      now: () => at,
      onHandlerError: engineOptions?.onHandlerError ?? 'incident',
      retry: engineOptions?.retry ?? { attempts: 0 },
    });
    return { instance, engine };
  }

  /**
   * O deployment com que a instância nasceu, não o mais recente: um redeploy
   * não troca o modelo debaixo de uma instância viva.
   */
  private async deploymentOf(instance: InstanceRecord): Promise<Deployment> {
    const deployment = await this.store.read(instance.processKey, instance.version);
    if (!deployment) {
      throw new Error(
        `A instância ${instance.id} aponta para ${instance.processKey} v${instance.version}, que não está publicado.`,
      );
    }
    return deployment;
  }
}
