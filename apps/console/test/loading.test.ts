import { describe, expect, it } from 'vitest';
import { lazy, serial } from '../src/loading.js';

/** Uma promessa que o teste resolve na hora que quiser. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('serial', () => {
  it('roda um trabalho de cada vez, na ordem em que foram pedidos', async () => {
    const queue = serial();
    const order: string[] = [];
    const slow = deferred<void>();

    const first = queue(async () => {
      order.push('A começou');
      await slow.promise;
      order.push('A terminou');
    });
    const second = queue(() => {
      order.push('B começou');
      order.push('B terminou');
      return Promise.resolve();
    });

    await Promise.resolve();
    // B não pode começar enquanto A (mais lento, mas pedido antes) não acabar:
    // senão A terminaria por último e deixaria o diagrama dele na tela.
    expect(order).toEqual(['A começou']);
    slow.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['A começou', 'A terminou', 'B começou', 'B terminou']);
  });

  it('uma falha não trava a fila e chega a quem pediu', async () => {
    const queue = serial();
    const failed = queue(() => Promise.reject(new Error('xml inválido')));
    const next = queue(() => Promise.resolve('ok'));

    await expect(failed).rejects.toThrow('xml inválido');
    await expect(next).resolves.toBe('ok');
  });
});

describe('lazy', () => {
  it('cria uma vez só, mesmo com pedidos simultâneos', async () => {
    let created = 0;
    const gate = deferred<void>();
    const get = lazy(async () => {
      await gate.promise;
      return ++created;
    });

    const a = get();
    const b = get();
    gate.resolve();

    expect(await a).toBe(1);
    expect(await b).toBe(1);
    expect(await get()).toBe(1);
  });

  it('tenta de novo depois de uma falha', async () => {
    let attempts = 0;
    const get = lazy(() =>
      ++attempts === 1 ? Promise.reject(new Error('rede')) : Promise.resolve(attempts),
    );

    await expect(get()).rejects.toThrow('rede');
    expect(await get()).toBe(2);
  });
});
