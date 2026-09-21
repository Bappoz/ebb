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

/** Service task marcada como job externo, na convenção do Zeebe/Camunda 8. */
export const EXTERNAL_JOB = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Charge" name="Charge card">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="charge" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f1" sourceRef="Start" targetRef="Charge" />
    <bpmn:sequenceFlow id="f2" sourceRef="Charge" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

/** O mesmo job externo, mas com um boundary de erro para negar o pedido. */
export const JOB_WITH_BOUNDARY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Charge" name="Charge card">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="charge" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="OnDeclined" attachedToRef="Charge">
      <bpmn:errorEventDefinition errorRef="Declined" />
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="End" />
    <bpmn:endEvent id="Declined" />
    <bpmn:sequenceFlow id="f1" sourceRef="Start" targetRef="Charge" />
    <bpmn:sequenceFlow id="f2" sourceRef="Charge" targetRef="End" />
    <bpmn:sequenceFlow id="f3" sourceRef="OnDeclined" targetRef="Declined" />
  </bpmn:process>
  <bpmn:error id="Declined" name="Declined" errorCode="DECLINED" />
</bpmn:definitions>`;
