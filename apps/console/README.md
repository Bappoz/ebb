# Console do ebb

O console reúne operação das instâncias, tarefas e incidentes com o BPMN
Studio. O editor é carregado quando a rota **Modelagem** é aberta, para manter
as telas operacionais leves.

## Editar um BPMN

1. Abra **Modelagem** na navegação lateral.
2. Escolha **Abrir BPMN** para importar `.bpmn` ou `.xml`, ou crie um diagrama.
3. Use **Validar** para conferir estruturas BPMN que o motor consegue executar.
   Diagnósticos ligados a um elemento selecionam esse elemento no canvas.
4. Abra **Arquitetura** para ver o inventário de atividades, gateways, dados,
   raias, candidatos, jobs e riscos estáticos. Baixe o relatório Markdown para
   compartilhar a revisão.
5. Salve as alterações.

Em navegadores com a File System Access API, o console pode gravar no arquivo
escolhido. Se ela não estiver disponível, o console abre o arquivo com um seletor
tradicional e **Salvar** baixa uma cópia. O navegador pede confirmação antes de
descartar alterações e detecta mudanças externas no arquivo quando o acesso
direto está disponível.

O Studio atualiza arquivos locais. Publicar versões no runtime a partir do
console e selecionar arquivos por uma árvore de projeto entram nas próximas
etapas do roadmap.

Raias, candidatos e tipos de job são declarações lidas do BPMN; o relatório não
infere ownership no código. A ligação entre os elementos do processo e os
arquivos que os implementam segue em desenvolvimento.
