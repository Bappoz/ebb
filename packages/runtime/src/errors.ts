/** A instância pedida não existe. */
export class InstanceNotFoundError extends Error {
  constructor(readonly instanceId: string) {
    super(`Nenhuma instância com o id "${instanceId}".`);
    this.name = 'InstanceNotFoundError';
  }
}

/**
 * O snapshot foi gravado por um motor de outro esquema.
 *
 * Vale a mensagem própria em vez da do motor porque a diferença importa: o
 * snapshot é cache e o journal é a verdade, então a instância não está
 * perdida — só não dá para retomá-la pelo atalho.
 */
export class EngineStateMismatchError extends Error {
  constructor(
    readonly instanceId: string,
    readonly stored: number,
    readonly expected: number,
  ) {
    super(
      `A instância ${instanceId} foi gravada com o esquema de motor ${stored} e este ebb usa o ${expected}. ` +
        'O journal está intacto — o replay poderá reconstruí-la; retomar pelo snapshot, não.',
    );
    this.name = 'EngineStateMismatchError';
  }
}
