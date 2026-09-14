import { describe, expect, it } from 'vitest';
import { DEFAULT_STORE_PATH, resolveStorePath } from '../src/paths.js';

describe('resolveStorePath', () => {
  it('cai no padrão, relativo ao diretório de trabalho', () => {
    expect(resolveStorePath(undefined, {}, '/projeto')).toBe(`/projeto/${DEFAULT_STORE_PATH}`);
  });

  it('a variável de ambiente vence o padrão', () => {
    expect(resolveStorePath(undefined, { EBB_STORE: 'dados/x.db' }, '/projeto')).toBe(
      '/projeto/dados/x.db',
    );
  });

  it('a opção vence a variável de ambiente', () => {
    expect(resolveStorePath('outro.db', { EBB_STORE: 'dados/x.db' }, '/projeto')).toBe(
      '/projeto/outro.db',
    );
  });

  it('respeita um caminho absoluto', () => {
    expect(resolveStorePath('/var/lib/ebb.db', {}, '/projeto')).toBe('/var/lib/ebb.db');
  });

  it('deixa :memory: passar como está', () => {
    expect(resolveStorePath(':memory:', {}, '/projeto')).toBe(':memory:');
  });
});
