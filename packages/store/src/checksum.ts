import { createHash } from 'node:crypto';

/**
 * Identidade de conteúdo de um diagrama.
 *
 * Publicar o mesmo arquivo duas vezes não deve criar duas versões, e "o mesmo
 * arquivo" aqui é byte a byte: reformatar o XML muda o diagrama do ponto de
 * vista de quem lê o diff, então conta como versão nova.
 */
export function checksumOf(xml: string): string {
  return createHash('sha256').update(xml, 'utf8').digest('hex');
}
