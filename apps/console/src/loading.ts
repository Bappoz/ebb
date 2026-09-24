/*
 * Concorrência da tela, fora do DOM para poder ser testada: o viewer é um só,
 * e duas navegações rápidas não podem deixar na tela o diagrama da mais velha.
 */

/**
 * Uma fila: cada trabalho só começa quando o anterior acabou, na ordem em que
 * foram pedidos. Com o carregamento do diagrama passando por ela, o da última
 * navegação é sempre o último a rodar — e o que fica na tela.
 */
export function serial(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job);
    // A falha vai para quem pediu; a fila segue.
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * Cria uma vez só, mesmo com pedidos simultâneos — a promessa é que fica
 * guardada, não o valor. Uma falha não fica guardada: o próximo pedido tenta
 * de novo.
 */
export function lazy<T>(create: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= create().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
