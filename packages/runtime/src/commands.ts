import type { ExecutionSnapshot, WorkflowEngine } from '@bpmn-flow/core';

/**
 * Tudo que muda uma instância, como dado.
 *
 * É o que faz o time-travel possível: a execução ao vivo e o replay do journal
 * passam os dois por {@link applyCommand}, então um comando gravado significa
 * exatamente o que significou quando foi aplicado.
 */
export type InstanceCommand =
  | { type: 'start'; variables?: Record<string, unknown> }
  | { type: 'completeTask'; tokenId: string; output?: Record<string, unknown> }
  | { type: 'signal'; name: string; output?: Record<string, unknown> }
  | { type: 'tick' };

export type CommandType = InstanceCommand['type'];

/** Aplica um comando ao motor. O único caminho — ao vivo e no replay. */
export function applyCommand(
  engine: WorkflowEngine,
  command: InstanceCommand,
): Promise<ExecutionSnapshot> {
  switch (command.type) {
    case 'start':
      // As variáveis iniciais entram na construção do motor, não aqui. Elas
      // ficam no payload porque o replay precisa construir o mesmo motor.
      return engine.start();
    case 'completeTask':
      return engine.completeTask(command.tokenId, command.output);
    case 'signal':
      return engine.signal(command.name, command.output);
    case 'tick':
      // Sem argumento de propósito: o relógio do motor já está congelado no
      // instante que o journal gravou.
      return engine.tick();
  }
}

/** O comando sem o tipo, que o journal guarda numa coluna própria. */
export function payloadOf(command: InstanceCommand): Record<string, unknown> {
  const { type: _type, ...payload } = command;
  return payload;
}
