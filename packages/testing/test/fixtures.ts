export const GATEWAY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Aprovacao" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Avaliar" />
    <bpmn:exclusiveGateway id="Gateway" default="Flow_Baixo" />
    <bpmn:userTask id="Diretoria" />
    <bpmn:endEvent id="EndAlto" />
    <bpmn:endEvent id="EndBaixo" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Avaliar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Avaliar" targetRef="Gateway" />
    <bpmn:sequenceFlow id="Flow_Alto" sourceRef="Gateway" targetRef="Diretoria">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">valor &gt; 100</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="Flow_Baixo" sourceRef="Gateway" targetRef="EndBaixo" />
    <bpmn:sequenceFlow id="f4" sourceRef="Diretoria" targetRef="EndAlto" />
  </bpmn:process>
</bpmn:definitions>`;

export const JOB = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Pedido" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Charge">
      <bpmn:extensionElements><zeebe:taskDefinition type="charge" /></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:userTask id="Review" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Charge" />
    <bpmn:sequenceFlow id="f1" sourceRef="Charge" targetRef="Review" />
    <bpmn:sequenceFlow id="f2" sourceRef="Review" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

export const JOB_WITH_BOUNDARY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Pedido" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Charge">
      <bpmn:extensionElements><zeebe:taskDefinition type="charge" /></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="OnDeclined" attachedToRef="Charge">
      <bpmn:errorEventDefinition errorRef="DeclinedError" />
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="Paid" />
    <bpmn:endEvent id="Declined" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Charge" />
    <bpmn:sequenceFlow id="f1" sourceRef="Charge" targetRef="Paid" />
    <bpmn:sequenceFlow id="f2" sourceRef="OnDeclined" targetRef="Declined" />
  </bpmn:process>
  <bpmn:error id="DeclinedError" errorCode="DECLINED" />
</bpmn:definitions>`;

export const TIMER = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Espera" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="Aguardar">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:userTask id="Conferir" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Aguardar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Aguardar" targetRef="Conferir" />
    <bpmn:sequenceFlow id="f2" sourceRef="Conferir" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

export const SIGNAL = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:signal id="ApprovedSignal" name="approved" />
  <bpmn:process id="SignalProcess" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="WaitApproved">
      <bpmn:signalEventDefinition signalRef="ApprovedSignal" />
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="WaitApproved" />
    <bpmn:sequenceFlow id="f1" sourceRef="WaitApproved" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;
