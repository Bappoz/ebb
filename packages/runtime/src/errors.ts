/** A instância pedida não existe. */
export class InstanceNotFoundError extends Error {
  constructor(readonly instanceId: string) {
    super(`Nenhuma instância com o id "${instanceId}".`);
    this.name = 'InstanceNotFoundError';
  }
}

/**
 * A instância já acabou.
 *
 * Existe para fechar o buraco que o chunk 1 deixou: sem isto, um `tick` numa
 * instância concluída acrescentava entrada no-op ao journal para sempre.
 * Determinístico, mas o journal passa a descrever coisa que não aconteceu.
 */
export class InstanceTerminatedError extends Error {
  constructor(
    readonly instanceId: string,
    readonly status: string,
  ) {
    super(`A instância ${instanceId} está ${status} e não aceita mais comandos.`);
    this.name = 'InstanceTerminatedError';
  }
}
