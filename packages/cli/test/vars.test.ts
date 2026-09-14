import { describe, expect, it } from 'vitest';
import { parseVars } from '../src/vars.js';

describe('parseVars', () => {
  it('lê JSON quando o valor parseia e texto quando não', () => {
    expect(parseVars(['--var', 'total=42', '--var', 'nome=ana', '--var', 'pago=true'])).toEqual({
      total: 42,
      nome: 'ana',
      pago: true,
    });
  });

  it('aceita objeto e lista', () => {
    expect(parseVars(['--var', 'itens=[1,2]', '--var', 'cliente={"id":7}'])).toEqual({
      itens: [1, 2],
      cliente: { id: 7 },
    });
  });

  it('preserva o = que aparece dentro do valor', () => {
    expect(parseVars(['--var', 'query=a=b'])).toEqual({ query: 'a=b' });
  });

  it('ignora o resto do argv', () => {
    expect(parseVars(['show', 'abc', '--store', 'x.db'])).toEqual({});
  });

  it('reclama de um par sem chave ou sem =', () => {
    expect(() => parseVars(['--var', 'solto'])).toThrow('chave=valor');
    expect(() => parseVars(['--var', '=1'])).toThrow('chave=valor');
    expect(() => parseVars(['--var'])).toThrow('chave=valor');
  });
});
