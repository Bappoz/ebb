/** BPMN mínimo compartilhado pelos testes do runtime: start → tarefa → end. */
export const PEDIDO = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Pedido" name="Processo de Pedido" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Separar" name="Separar itens" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Separar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Separar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;
