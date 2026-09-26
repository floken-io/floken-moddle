/**
 * BPMN 2.0 语义层类型表 —— 137 类型 / 318 属性定义（自动生成）
 *
 * ⚠️ **自动生成，请勿手改** —— 改了也会被下一次 gen:spec 覆盖。
 *   要改就改 scripts/gen-bpmn-spec.mjs。
 *
 * 源文件（生成期依赖，MIT，不进 dependencies）：bpmn-moddle 的描述符 JSON。
 * abstract 校正源：OMG Semantic.xsd 原件（complexType@abstract ∪ element@abstract）。
 *
 * abstract 裁定：描述符标 True 的 17 个照单全收；其中 FlowElementsContainer /
 * InteractionNode / CallableElement 在 XSD 侧拿不到 abstract 依据，仍取 True ——
 * 理由登记在 scripts/gen-bpmn-spec.mjs 的 DESC_ONLY_ABSTRACT 里（前两个 XSD 压根
 * 没有对应 complexType，第三个是 OMG 漏标）。
 * ★ SubProcess **不是**抽象类型 —— 这是「26 类可执行节点」的依据。
 * @see 流程引擎包文档/01-包需求-floken-moddle.md §3
 */

import type { BpmnTypeSpec, PropertySpec } from './spec-types.js';

/** 复用同一个冻结空数组，避免每个无属性类型各建一份 */
const EMPTY_PROPERTIES: readonly PropertySpec[] = Object.freeze([]);

/** BPMN 语义层：http://www.omg.org/spec/BPMN/20100524/MODEL */
export const BPMN_TYPES: readonly BpmnTypeSpec[] = [
  { name: "Interface", ns: "bpmn", superClass: ["RootElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "operations", type: "Operation", isMany: true },
      { name: "implementationRef", type: "String", isAttr: true }
    ],
  },
  { name: "Operation", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "inMessageRef", type: "Message", isReference: true },
      { name: "outMessageRef", type: "Message", isReference: true },
      { name: "errorRef", type: "Error", isMany: true, isReference: true },
      { name: "implementationRef", type: "String", isAttr: true }
    ],
  },
  { name: "EndPoint", ns: "bpmn", superClass: ["RootElement"], properties: EMPTY_PROPERTIES },
  { name: "Auditing", ns: "bpmn", superClass: ["BaseElement"], properties: EMPTY_PROPERTIES },
  { name: "GlobalTask", ns: "bpmn", superClass: ["CallableElement"],
    properties: [
      { name: "resources", type: "ResourceRole", isMany: true }
    ],
  },
  { name: "Monitoring", ns: "bpmn", superClass: ["BaseElement"], properties: EMPTY_PROPERTIES },
  { name: "Performer", ns: "bpmn", superClass: ["ResourceRole"], properties: EMPTY_PROPERTIES },
  { name: "Process", ns: "bpmn", superClass: ["FlowElementsContainer","CallableElement"],
    properties: [
      { name: "processType", type: "ProcessType", isAttr: true },
      { name: "isClosed", type: "Boolean", isAttr: true },
      { name: "auditing", type: "Auditing" },
      { name: "monitoring", type: "Monitoring" },
      { name: "properties", type: "Property", isMany: true },
      { name: "laneSets", type: "LaneSet", isMany: true, replaces: "FlowElementsContainer#laneSets" },
      { name: "flowElements", type: "FlowElement", isMany: true, replaces: "FlowElementsContainer#flowElements" },
      { name: "artifacts", type: "Artifact", isMany: true },
      { name: "resources", type: "ResourceRole", isMany: true },
      { name: "correlationSubscriptions", type: "CorrelationSubscription", isMany: true },
      { name: "supports", type: "Process", isMany: true, isReference: true },
      { name: "definitionalCollaborationRef", type: "Collaboration", isAttr: true, isReference: true },
      { name: "isExecutable", type: "Boolean", isAttr: true }
    ],
  },
  { name: "LaneSet", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "lanes", type: "Lane", isMany: true },
      { name: "name", type: "String", isAttr: true }
    ],
  },
  { name: "Lane", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "partitionElementRef", type: "BaseElement", isAttr: true, isReference: true },
      { name: "partitionElement", type: "BaseElement" },
      { name: "flowNodeRef", type: "FlowNode", isMany: true, isReference: true },
      { name: "childLaneSet", type: "LaneSet", xml: {"serialize":"xsi:type"} }
    ],
  },
  { name: "GlobalManualTask", ns: "bpmn", superClass: ["GlobalTask"], properties: EMPTY_PROPERTIES },
  { name: "ManualTask", ns: "bpmn", superClass: ["Task"], properties: EMPTY_PROPERTIES },
  { name: "UserTask", ns: "bpmn", superClass: ["Task"],
    properties: [
      { name: "renderings", type: "Rendering", isMany: true },
      { name: "implementation", type: "String", isAttr: true }
    ],
  },
  { name: "Rendering", ns: "bpmn", superClass: ["BaseElement"], properties: EMPTY_PROPERTIES },
  { name: "HumanPerformer", ns: "bpmn", superClass: ["Performer"], properties: EMPTY_PROPERTIES },
  { name: "PotentialOwner", ns: "bpmn", superClass: ["HumanPerformer"], properties: EMPTY_PROPERTIES },
  { name: "GlobalUserTask", ns: "bpmn", superClass: ["GlobalTask"],
    properties: [
      { name: "implementation", type: "String", isAttr: true },
      { name: "renderings", type: "Rendering", isMany: true }
    ],
  },
  { name: "Gateway", ns: "bpmn", superClass: ["FlowNode"], isAbstract: true,
    properties: [
      { name: "gatewayDirection", type: "GatewayDirection", isAttr: true, default: "Unspecified" }
    ],
  },
  { name: "EventBasedGateway", ns: "bpmn", superClass: ["Gateway"],
    properties: [
      { name: "instantiate", type: "Boolean", isAttr: true, default: false },
      { name: "eventGatewayType", type: "EventBasedGatewayType", isAttr: true, default: "Exclusive" }
    ],
  },
  { name: "ComplexGateway", ns: "bpmn", superClass: ["Gateway"],
    properties: [
      { name: "activationCondition", type: "Expression", xml: {"serialize":"xsi:type"} },
      { name: "default", type: "SequenceFlow", isAttr: true, isReference: true }
    ],
  },
  { name: "ExclusiveGateway", ns: "bpmn", superClass: ["Gateway"],
    properties: [
      { name: "default", type: "SequenceFlow", isAttr: true, isReference: true }
    ],
  },
  { name: "InclusiveGateway", ns: "bpmn", superClass: ["Gateway"],
    properties: [
      { name: "default", type: "SequenceFlow", isAttr: true, isReference: true }
    ],
  },
  { name: "ParallelGateway", ns: "bpmn", superClass: ["Gateway"], properties: EMPTY_PROPERTIES },
  { name: "RootElement", ns: "bpmn", superClass: ["BaseElement"], isAbstract: true, properties: EMPTY_PROPERTIES },
  { name: "Relationship", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "type", type: "String", isAttr: true },
      { name: "direction", type: "RelationshipDirection", isAttr: true },
      { name: "source", type: "Element", isMany: true, isReference: true },
      { name: "target", type: "Element", isMany: true, isReference: true }
    ],
  },
  { name: "BaseElement", ns: "bpmn", isAbstract: true,
    properties: [
      { name: "id", type: "String", isAttr: true, isId: true },
      { name: "documentation", type: "Documentation", isMany: true },
      { name: "extensionDefinitions", type: "ExtensionDefinition", isMany: true, isReference: true },
      { name: "extensionElements", type: "ExtensionElements" }
    ],
  },
  { name: "Extension", ns: "bpmn",
    properties: [
      { name: "mustUnderstand", type: "Boolean", isAttr: true, default: false },
      { name: "definition", type: "ExtensionDefinition", isAttr: true, isReference: true }
    ],
  },
  { name: "ExtensionDefinition", ns: "bpmn", existsInXsd: false,
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "extensionAttributeDefinitions", type: "ExtensionAttributeDefinition", isMany: true }
    ],
  },
  { name: "ExtensionAttributeDefinition", ns: "bpmn", existsInXsd: false,
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "type", type: "String", isAttr: true },
      { name: "isReference", type: "Boolean", isAttr: true, default: false },
      { name: "extensionDefinition", type: "ExtensionDefinition", isAttr: true, isReference: true }
    ],
  },
  { name: "ExtensionElements", ns: "bpmn",
    properties: [
      { name: "valueRef", type: "Element", isAttr: true, isReference: true },
      { name: "values", type: "Element", isMany: true },
      { name: "extensionAttributeDefinition", type: "ExtensionAttributeDefinition", isAttr: true, isReference: true }
    ],
  },
  { name: "Documentation", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "text", type: "String", isBody: true },
      { name: "textFormat", type: "String", isAttr: true, default: "text/plain" }
    ],
  },
  { name: "Event", ns: "bpmn", superClass: ["FlowNode","InteractionNode"], isAbstract: true,
    properties: [
      { name: "properties", type: "Property", isMany: true }
    ],
  },
  { name: "IntermediateCatchEvent", ns: "bpmn", superClass: ["CatchEvent"], properties: EMPTY_PROPERTIES },
  { name: "IntermediateThrowEvent", ns: "bpmn", superClass: ["ThrowEvent"], properties: EMPTY_PROPERTIES },
  { name: "EndEvent", ns: "bpmn", superClass: ["ThrowEvent"], properties: EMPTY_PROPERTIES },
  { name: "StartEvent", ns: "bpmn", superClass: ["CatchEvent"],
    properties: [
      { name: "isInterrupting", type: "Boolean", isAttr: true, default: true }
    ],
  },
  { name: "ThrowEvent", ns: "bpmn", superClass: ["Event"], isAbstract: true,
    properties: [
      { name: "dataInputs", type: "DataInput", isMany: true },
      { name: "dataInputAssociations", type: "DataInputAssociation", isMany: true },
      { name: "inputSet", type: "InputSet" },
      { name: "eventDefinitions", type: "EventDefinition", isMany: true },
      { name: "eventDefinitionRef", type: "EventDefinition", isMany: true, isReference: true }
    ],
  },
  { name: "CatchEvent", ns: "bpmn", superClass: ["Event"], isAbstract: true,
    properties: [
      { name: "parallelMultiple", type: "Boolean", isAttr: true, default: false },
      { name: "dataOutputs", type: "DataOutput", isMany: true },
      { name: "dataOutputAssociations", type: "DataOutputAssociation", isMany: true },
      { name: "outputSet", type: "OutputSet" },
      { name: "eventDefinitions", type: "EventDefinition", isMany: true },
      { name: "eventDefinitionRef", type: "EventDefinition", isMany: true, isReference: true }
    ],
  },
  { name: "BoundaryEvent", ns: "bpmn", superClass: ["CatchEvent"],
    properties: [
      { name: "cancelActivity", type: "Boolean", isAttr: true, default: true },
      { name: "attachedToRef", type: "Activity", isAttr: true, isReference: true }
    ],
  },
  { name: "EventDefinition", ns: "bpmn", superClass: ["RootElement"], isAbstract: true, properties: EMPTY_PROPERTIES },
  { name: "CancelEventDefinition", ns: "bpmn", superClass: ["EventDefinition"], properties: EMPTY_PROPERTIES },
  { name: "ErrorEventDefinition", ns: "bpmn", superClass: ["EventDefinition"],
    properties: [
      { name: "errorRef", type: "Error", isAttr: true, isReference: true }
    ],
  },
  { name: "TerminateEventDefinition", ns: "bpmn", superClass: ["EventDefinition"], properties: EMPTY_PROPERTIES },
  { name: "EscalationEventDefinition", ns: "bpmn", superClass: ["EventDefinition"],
    properties: [
      { name: "escalationRef", type: "Escalation", isAttr: true, isReference: true }
    ],
  },
  { name: "Escalation", ns: "bpmn", superClass: ["RootElement"],
    properties: [
      { name: "structureRef", type: "ItemDefinition", isAttr: true, isReference: true },
      { name: "name", type: "String", isAttr: true },
      { name: "escalationCode", type: "String", isAttr: true }
    ],
  },
  { name: "CompensateEventDefinition", ns: "bpmn", superClass: ["EventDefinition"],
    properties: [
      { name: "waitForCompletion", type: "Boolean", isAttr: true, default: true },
      { name: "activityRef", type: "Activity", isAttr: true, isReference: true }
    ],
  },
  { name: "TimerEventDefinition", ns: "bpmn", superClass: ["EventDefinition"],
    properties: [
      { name: "timeDate", type: "Expression", xml: {"serialize":"xsi:type"} },
      { name: "timeCycle", type: "Expression", xml: {"serialize":"xsi:type"} },
      { name: "timeDuration", type: "Expression", xml: {"serialize":"xsi:type"} }
    ],
  },
  { name: "LinkEventDefinition", ns: "bpmn", superClass: ["EventDefinition"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "target", type: "LinkEventDefinition", isReference: true },
      { name: "source", type: "LinkEventDefinition", isMany: true, isReference: true }
    ],
  },
  { name: "MessageEventDefinition", ns: "bpmn", superClass: ["EventDefinition"],
    properties: [
      { name: "messageRef", type: "Message", isAttr: true, isReference: true },
      { name: "operationRef", type: "Operation", isReference: true }
    ],
  },
  { name: "ConditionalEventDefinition", ns: "bpmn", superClass: ["EventDefinition"],
    properties: [
      { name: "condition", type: "Expression", xml: {"serialize":"xsi:type"} }
    ],
  },
  { name: "SignalEventDefinition", ns: "bpmn", superClass: ["EventDefinition"],
    properties: [
      { name: "signalRef", type: "Signal", isAttr: true, isReference: true }
    ],
  },
  { name: "Signal", ns: "bpmn", superClass: ["RootElement"],
    properties: [
      { name: "structureRef", type: "ItemDefinition", isAttr: true, isReference: true },
      { name: "name", type: "String", isAttr: true }
    ],
  },
  { name: "ImplicitThrowEvent", ns: "bpmn", superClass: ["ThrowEvent"], properties: EMPTY_PROPERTIES },
  { name: "DataState", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "name", type: "String", isAttr: true }
    ],
  },
  { name: "ItemAwareElement", ns: "bpmn", superClass: ["BaseElement"], existsInXsd: false,
    properties: [
      { name: "itemSubjectRef", type: "ItemDefinition", isAttr: true, isReference: true },
      { name: "dataState", type: "DataState" }
    ],
  },
  { name: "DataAssociation", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "sourceRef", type: "ItemAwareElement", isMany: true, isReference: true },
      { name: "targetRef", type: "ItemAwareElement", isReference: true },
      { name: "transformation", type: "FormalExpression", xml: {"serialize":"property"} },
      { name: "assignment", type: "Assignment", isMany: true }
    ],
  },
  { name: "DataInput", ns: "bpmn", superClass: ["ItemAwareElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "isCollection", type: "Boolean", isAttr: true, default: false },
      { name: "inputSetRef", type: "InputSet", isMany: true, isReference: true, isVirtual: true },
      { name: "inputSetWithOptional", type: "InputSet", isMany: true, isReference: true, isVirtual: true },
      { name: "inputSetWithWhileExecuting", type: "InputSet", isMany: true, isReference: true, isVirtual: true }
    ],
  },
  { name: "DataOutput", ns: "bpmn", superClass: ["ItemAwareElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "isCollection", type: "Boolean", isAttr: true, default: false },
      { name: "outputSetRef", type: "OutputSet", isMany: true, isReference: true, isVirtual: true },
      { name: "outputSetWithOptional", type: "OutputSet", isMany: true, isReference: true, isVirtual: true },
      { name: "outputSetWithWhileExecuting", type: "OutputSet", isMany: true, isReference: true, isVirtual: true }
    ],
  },
  { name: "InputSet", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "dataInputRefs", type: "DataInput", isMany: true, isReference: true },
      { name: "optionalInputRefs", type: "DataInput", isMany: true, isReference: true },
      { name: "whileExecutingInputRefs", type: "DataInput", isMany: true, isReference: true },
      { name: "outputSetRefs", type: "OutputSet", isMany: true, isReference: true }
    ],
  },
  { name: "OutputSet", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "dataOutputRefs", type: "DataOutput", isMany: true, isReference: true },
      { name: "name", type: "String", isAttr: true },
      { name: "inputSetRefs", type: "InputSet", isMany: true, isReference: true },
      { name: "optionalOutputRefs", type: "DataOutput", isMany: true, isReference: true },
      { name: "whileExecutingOutputRefs", type: "DataOutput", isMany: true, isReference: true }
    ],
  },
  { name: "Property", ns: "bpmn", superClass: ["ItemAwareElement"],
    properties: [
      { name: "name", type: "String", isAttr: true }
    ],
  },
  { name: "DataInputAssociation", ns: "bpmn", superClass: ["DataAssociation"], properties: EMPTY_PROPERTIES },
  { name: "DataOutputAssociation", ns: "bpmn", superClass: ["DataAssociation"], properties: EMPTY_PROPERTIES },
  { name: "InputOutputSpecification", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "dataInputs", type: "DataInput", isMany: true },
      { name: "dataOutputs", type: "DataOutput", isMany: true },
      { name: "inputSets", type: "InputSet", isMany: true },
      { name: "outputSets", type: "OutputSet", isMany: true }
    ],
  },
  { name: "DataObject", ns: "bpmn", superClass: ["FlowElement","ItemAwareElement"],
    properties: [
      { name: "isCollection", type: "Boolean", isAttr: true, default: false }
    ],
  },
  { name: "InputOutputBinding", ns: "bpmn",
    properties: [
      { name: "inputDataRef", type: "InputSet", isAttr: true, isReference: true },
      { name: "outputDataRef", type: "OutputSet", isAttr: true, isReference: true },
      { name: "operationRef", type: "Operation", isAttr: true, isReference: true }
    ],
  },
  { name: "Assignment", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "from", type: "Expression", xml: {"serialize":"xsi:type"} },
      { name: "to", type: "Expression", xml: {"serialize":"xsi:type"} }
    ],
  },
  { name: "DataStore", ns: "bpmn", superClass: ["RootElement","ItemAwareElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "capacity", type: "Integer", isAttr: true },
      { name: "isUnlimited", type: "Boolean", isAttr: true, default: true }
    ],
  },
  { name: "DataStoreReference", ns: "bpmn", superClass: ["ItemAwareElement","FlowElement"],
    properties: [
      { name: "dataStoreRef", type: "DataStore", isAttr: true, isReference: true }
    ],
  },
  { name: "DataObjectReference", ns: "bpmn", superClass: ["ItemAwareElement","FlowElement"],
    properties: [
      { name: "dataObjectRef", type: "DataObject", isAttr: true, isReference: true }
    ],
  },
  { name: "ConversationLink", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "sourceRef", type: "InteractionNode", isAttr: true, isReference: true },
      { name: "targetRef", type: "InteractionNode", isAttr: true, isReference: true },
      { name: "name", type: "String", isAttr: true }
    ],
  },
  { name: "ConversationAssociation", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "innerConversationNodeRef", type: "ConversationNode", isAttr: true, isReference: true },
      { name: "outerConversationNodeRef", type: "ConversationNode", isAttr: true, isReference: true }
    ],
  },
  { name: "CallConversation", ns: "bpmn", superClass: ["ConversationNode"],
    properties: [
      { name: "calledCollaborationRef", type: "Collaboration", isAttr: true, isReference: true },
      { name: "participantAssociations", type: "ParticipantAssociation", isMany: true }
    ],
  },
  { name: "Conversation", ns: "bpmn", superClass: ["ConversationNode"], properties: EMPTY_PROPERTIES },
  { name: "SubConversation", ns: "bpmn", superClass: ["ConversationNode"],
    properties: [
      { name: "conversationNodes", type: "ConversationNode", isMany: true }
    ],
  },
  { name: "ConversationNode", ns: "bpmn", superClass: ["InteractionNode","BaseElement"], isAbstract: true,
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "participantRef", type: "Participant", isMany: true, isReference: true },
      { name: "messageFlowRefs", type: "MessageFlow", isMany: true, isReference: true },
      { name: "correlationKeys", type: "CorrelationKey", isMany: true }
    ],
  },
  { name: "GlobalConversation", ns: "bpmn", superClass: ["Collaboration"], properties: EMPTY_PROPERTIES },
  { name: "PartnerEntity", ns: "bpmn", superClass: ["RootElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "participantRef", type: "Participant", isMany: true, isReference: true }
    ],
  },
  { name: "PartnerRole", ns: "bpmn", superClass: ["RootElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "participantRef", type: "Participant", isMany: true, isReference: true }
    ],
  },
  { name: "CorrelationProperty", ns: "bpmn", superClass: ["RootElement"],
    properties: [
      { name: "correlationPropertyRetrievalExpression", type: "CorrelationPropertyRetrievalExpression", isMany: true },
      { name: "name", type: "String", isAttr: true },
      { name: "type", type: "ItemDefinition", isAttr: true, isReference: true }
    ],
  },
  { name: "Error", ns: "bpmn", superClass: ["RootElement"],
    properties: [
      { name: "structureRef", type: "ItemDefinition", isAttr: true, isReference: true },
      { name: "name", type: "String", isAttr: true },
      { name: "errorCode", type: "String", isAttr: true }
    ],
  },
  { name: "CorrelationKey", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "correlationPropertyRef", type: "CorrelationProperty", isMany: true, isReference: true },
      { name: "name", type: "String", isAttr: true }
    ],
  },
  { name: "Expression", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "body", type: "String", isBody: true }
    ],
  },
  { name: "FormalExpression", ns: "bpmn", superClass: ["Expression"],
    properties: [
      { name: "language", type: "String", isAttr: true },
      { name: "evaluatesToTypeRef", type: "ItemDefinition", isAttr: true, isReference: true }
    ],
  },
  { name: "Message", ns: "bpmn", superClass: ["RootElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "itemRef", type: "ItemDefinition", isAttr: true, isReference: true }
    ],
  },
  { name: "ItemDefinition", ns: "bpmn", superClass: ["RootElement"],
    properties: [
      { name: "itemKind", type: "ItemKind", isAttr: true },
      { name: "structureRef", type: "String", isAttr: true },
      { name: "isCollection", type: "Boolean", isAttr: true, default: false },
      { name: "import", type: "Import", isAttr: true, isReference: true }
    ],
  },
  { name: "FlowElement", ns: "bpmn", superClass: ["BaseElement"], isAbstract: true,
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "auditing", type: "Auditing" },
      { name: "monitoring", type: "Monitoring" },
      { name: "categoryValueRef", type: "CategoryValue", isMany: true, isReference: true }
    ],
  },
  { name: "SequenceFlow", ns: "bpmn", superClass: ["FlowElement"],
    properties: [
      { name: "isImmediate", type: "Boolean", isAttr: true },
      { name: "conditionExpression", type: "Expression", xml: {"serialize":"xsi:type"} },
      { name: "sourceRef", type: "FlowNode", isAttr: true, isReference: true },
      { name: "targetRef", type: "FlowNode", isAttr: true, isReference: true }
    ],
  },
  { name: "FlowElementsContainer", ns: "bpmn", superClass: ["BaseElement"], isAbstract: true, existsInXsd: false,
    properties: [
      { name: "laneSets", type: "LaneSet", isMany: true },
      { name: "flowElements", type: "FlowElement", isMany: true }
    ],
  },
  { name: "CallableElement", ns: "bpmn", superClass: ["RootElement"], isAbstract: true,
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "ioSpecification", type: "InputOutputSpecification", xml: {"serialize":"property"} },
      { name: "supportedInterfaceRef", type: "Interface", isMany: true, isReference: true },
      { name: "ioBinding", type: "InputOutputBinding", isMany: true, xml: {"serialize":"property"} }
    ],
  },
  { name: "FlowNode", ns: "bpmn", superClass: ["FlowElement"], isAbstract: true,
    properties: [
      { name: "incoming", type: "SequenceFlow", isMany: true, isReference: true },
      { name: "outgoing", type: "SequenceFlow", isMany: true, isReference: true },
      { name: "lanes", type: "Lane", isMany: true, isReference: true, isVirtual: true }
    ],
  },
  { name: "CorrelationPropertyRetrievalExpression", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "messagePath", type: "FormalExpression" },
      { name: "messageRef", type: "Message", isAttr: true, isReference: true }
    ],
  },
  { name: "CorrelationPropertyBinding", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "dataPath", type: "FormalExpression" },
      { name: "correlationPropertyRef", type: "CorrelationProperty", isAttr: true, isReference: true }
    ],
  },
  { name: "Resource", ns: "bpmn", superClass: ["RootElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "resourceParameters", type: "ResourceParameter", isMany: true }
    ],
  },
  { name: "ResourceParameter", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "isRequired", type: "Boolean", isAttr: true },
      { name: "type", type: "ItemDefinition", isAttr: true, isReference: true }
    ],
  },
  { name: "CorrelationSubscription", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "correlationKeyRef", type: "CorrelationKey", isAttr: true, isReference: true },
      { name: "correlationPropertyBinding", type: "CorrelationPropertyBinding", isMany: true }
    ],
  },
  { name: "MessageFlow", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "sourceRef", type: "InteractionNode", isAttr: true, isReference: true },
      { name: "targetRef", type: "InteractionNode", isAttr: true, isReference: true },
      { name: "messageRef", type: "Message", isAttr: true, isReference: true }
    ],
  },
  { name: "MessageFlowAssociation", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "innerMessageFlowRef", type: "MessageFlow", isAttr: true, isReference: true },
      { name: "outerMessageFlowRef", type: "MessageFlow", isAttr: true, isReference: true }
    ],
  },
  { name: "InteractionNode", ns: "bpmn", isAbstract: true, existsInXsd: false,
    properties: [
      { name: "incomingConversationLinks", type: "ConversationLink", isMany: true, isReference: true, isVirtual: true },
      { name: "outgoingConversationLinks", type: "ConversationLink", isMany: true, isReference: true, isVirtual: true }
    ],
  },
  { name: "Participant", ns: "bpmn", superClass: ["InteractionNode","BaseElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "interfaceRef", type: "Interface", isMany: true, isReference: true },
      { name: "participantMultiplicity", type: "ParticipantMultiplicity" },
      { name: "endPointRefs", type: "EndPoint", isMany: true, isReference: true },
      { name: "processRef", type: "Process", isAttr: true, isReference: true }
    ],
  },
  { name: "ParticipantAssociation", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "innerParticipantRef", type: "Participant", isAttr: true, isReference: true },
      { name: "outerParticipantRef", type: "Participant", isAttr: true, isReference: true }
    ],
  },
  { name: "ParticipantMultiplicity", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "minimum", type: "Integer", isAttr: true, default: 0 },
      { name: "maximum", type: "Integer", isAttr: true, default: 1 }
    ],
  },
  { name: "Collaboration", ns: "bpmn", superClass: ["RootElement"],
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "isClosed", type: "Boolean", isAttr: true },
      { name: "participants", type: "Participant", isMany: true },
      { name: "messageFlows", type: "MessageFlow", isMany: true },
      { name: "artifacts", type: "Artifact", isMany: true },
      { name: "conversations", type: "ConversationNode", isMany: true },
      { name: "conversationAssociations", type: "ConversationAssociation" },
      { name: "participantAssociations", type: "ParticipantAssociation", isMany: true },
      { name: "messageFlowAssociations", type: "MessageFlowAssociation", isMany: true },
      { name: "correlationKeys", type: "CorrelationKey", isMany: true },
      { name: "choreographyRef", type: "Choreography", isMany: true, isReference: true },
      { name: "conversationLinks", type: "ConversationLink", isMany: true }
    ],
  },
  { name: "ChoreographyActivity", ns: "bpmn", superClass: ["FlowNode"], isAbstract: true,
    properties: [
      { name: "participantRef", type: "Participant", isMany: true, isReference: true },
      { name: "initiatingParticipantRef", type: "Participant", isAttr: true, isReference: true },
      { name: "correlationKeys", type: "CorrelationKey", isMany: true },
      { name: "loopType", type: "ChoreographyLoopType", isAttr: true, default: "None" }
    ],
  },
  { name: "CallChoreography", ns: "bpmn", superClass: ["ChoreographyActivity"],
    properties: [
      { name: "calledChoreographyRef", type: "Choreography", isAttr: true, isReference: true },
      { name: "participantAssociations", type: "ParticipantAssociation", isMany: true }
    ],
  },
  { name: "SubChoreography", ns: "bpmn", superClass: ["ChoreographyActivity","FlowElementsContainer"],
    properties: [
      { name: "artifacts", type: "Artifact", isMany: true }
    ],
  },
  { name: "ChoreographyTask", ns: "bpmn", superClass: ["ChoreographyActivity"],
    properties: [
      { name: "messageFlowRef", type: "MessageFlow", isMany: true, isReference: true }
    ],
  },
  { name: "Choreography", ns: "bpmn", superClass: ["Collaboration","FlowElementsContainer"], properties: EMPTY_PROPERTIES },
  { name: "GlobalChoreographyTask", ns: "bpmn", superClass: ["Choreography"],
    properties: [
      { name: "initiatingParticipantRef", type: "Participant", isAttr: true, isReference: true }
    ],
  },
  { name: "TextAnnotation", ns: "bpmn", superClass: ["Artifact"],
    properties: [
      { name: "text", type: "String" },
      { name: "textFormat", type: "String", isAttr: true, default: "text/plain" }
    ],
  },
  { name: "Group", ns: "bpmn", superClass: ["Artifact"],
    properties: [
      { name: "categoryValueRef", type: "CategoryValue", isAttr: true, isReference: true }
    ],
  },
  { name: "Association", ns: "bpmn", superClass: ["Artifact"],
    properties: [
      { name: "associationDirection", type: "AssociationDirection", isAttr: true },
      { name: "sourceRef", type: "BaseElement", isAttr: true, isReference: true },
      { name: "targetRef", type: "BaseElement", isAttr: true, isReference: true }
    ],
  },
  { name: "Category", ns: "bpmn", superClass: ["RootElement"],
    properties: [
      { name: "categoryValue", type: "CategoryValue", isMany: true },
      { name: "name", type: "String", isAttr: true }
    ],
  },
  { name: "Artifact", ns: "bpmn", superClass: ["BaseElement"], isAbstract: true, properties: EMPTY_PROPERTIES },
  { name: "CategoryValue", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "categorizedFlowElements", type: "FlowElement", isMany: true, isReference: true, isVirtual: true },
      { name: "value", type: "String", isAttr: true }
    ],
  },
  { name: "Activity", ns: "bpmn", superClass: ["FlowNode"], isAbstract: true,
    properties: [
      { name: "isForCompensation", type: "Boolean", isAttr: true, default: false },
      { name: "default", type: "SequenceFlow", isAttr: true, isReference: true },
      { name: "ioSpecification", type: "InputOutputSpecification", xml: {"serialize":"property"} },
      { name: "boundaryEventRefs", type: "BoundaryEvent", isMany: true, isReference: true },
      { name: "properties", type: "Property", isMany: true },
      { name: "dataInputAssociations", type: "DataInputAssociation", isMany: true },
      { name: "dataOutputAssociations", type: "DataOutputAssociation", isMany: true },
      { name: "startQuantity", type: "Integer", isAttr: true, default: 1 },
      { name: "resources", type: "ResourceRole", isMany: true },
      { name: "completionQuantity", type: "Integer", isAttr: true, default: 1 },
      { name: "loopCharacteristics", type: "LoopCharacteristics" }
    ],
  },
  { name: "ServiceTask", ns: "bpmn", superClass: ["Task"],
    properties: [
      { name: "implementation", type: "String", isAttr: true },
      { name: "operationRef", type: "Operation", isAttr: true, isReference: true }
    ],
  },
  { name: "SubProcess", ns: "bpmn", superClass: ["Activity","FlowElementsContainer","InteractionNode"],
    properties: [
      { name: "triggeredByEvent", type: "Boolean", isAttr: true, default: false },
      { name: "artifacts", type: "Artifact", isMany: true }
    ],
  },
  { name: "LoopCharacteristics", ns: "bpmn", superClass: ["BaseElement"], isAbstract: true, properties: EMPTY_PROPERTIES },
  { name: "MultiInstanceLoopCharacteristics", ns: "bpmn", superClass: ["LoopCharacteristics"],
    properties: [
      { name: "isSequential", type: "Boolean", isAttr: true, default: false },
      { name: "behavior", type: "MultiInstanceBehavior", isAttr: true, default: "All" },
      { name: "loopCardinality", type: "Expression", xml: {"serialize":"xsi:type"} },
      { name: "loopDataInputRef", type: "ItemAwareElement", isReference: true },
      { name: "loopDataOutputRef", type: "ItemAwareElement", isReference: true },
      { name: "inputDataItem", type: "DataInput", xml: {"serialize":"property"} },
      { name: "outputDataItem", type: "DataOutput", xml: {"serialize":"property"} },
      { name: "complexBehaviorDefinition", type: "ComplexBehaviorDefinition", isMany: true },
      { name: "completionCondition", type: "Expression", xml: {"serialize":"xsi:type"} },
      { name: "oneBehaviorEventRef", type: "EventDefinition", isAttr: true, isReference: true },
      { name: "noneBehaviorEventRef", type: "EventDefinition", isAttr: true, isReference: true }
    ],
  },
  { name: "StandardLoopCharacteristics", ns: "bpmn", superClass: ["LoopCharacteristics"],
    properties: [
      { name: "testBefore", type: "Boolean", isAttr: true, default: false },
      { name: "loopCondition", type: "Expression", xml: {"serialize":"xsi:type"} },
      { name: "loopMaximum", type: "Integer", isAttr: true }
    ],
  },
  { name: "CallActivity", ns: "bpmn", superClass: ["Activity","InteractionNode"],
    properties: [
      { name: "calledElement", type: "String", isAttr: true }
    ],
  },
  { name: "Task", ns: "bpmn", superClass: ["Activity","InteractionNode"], properties: EMPTY_PROPERTIES },
  { name: "SendTask", ns: "bpmn", superClass: ["Task"],
    properties: [
      { name: "implementation", type: "String", isAttr: true },
      { name: "operationRef", type: "Operation", isAttr: true, isReference: true },
      { name: "messageRef", type: "Message", isAttr: true, isReference: true }
    ],
  },
  { name: "ReceiveTask", ns: "bpmn", superClass: ["Task"],
    properties: [
      { name: "implementation", type: "String", isAttr: true },
      { name: "instantiate", type: "Boolean", isAttr: true, default: false },
      { name: "operationRef", type: "Operation", isAttr: true, isReference: true },
      { name: "messageRef", type: "Message", isAttr: true, isReference: true }
    ],
  },
  { name: "ScriptTask", ns: "bpmn", superClass: ["Task"],
    properties: [
      { name: "scriptFormat", type: "String", isAttr: true },
      { name: "script", type: "String" }
    ],
  },
  { name: "BusinessRuleTask", ns: "bpmn", superClass: ["Task"],
    properties: [
      { name: "implementation", type: "String", isAttr: true }
    ],
  },
  { name: "AdHocSubProcess", ns: "bpmn", superClass: ["SubProcess"],
    properties: [
      { name: "completionCondition", type: "Expression", xml: {"serialize":"xsi:type"} },
      { name: "ordering", type: "AdHocOrdering", isAttr: true },
      { name: "cancelRemainingInstances", type: "Boolean", isAttr: true, default: true }
    ],
  },
  { name: "Transaction", ns: "bpmn", superClass: ["SubProcess"],
    properties: [
      { name: "protocol", type: "String", isAttr: true },
      { name: "method", type: "String", isAttr: true }
    ],
  },
  { name: "GlobalScriptTask", ns: "bpmn", superClass: ["GlobalTask"],
    properties: [
      { name: "scriptLanguage", type: "String", isAttr: true },
      { name: "script", type: "String", isAttr: true }
    ],
  },
  { name: "GlobalBusinessRuleTask", ns: "bpmn", superClass: ["GlobalTask"],
    properties: [
      { name: "implementation", type: "String", isAttr: true }
    ],
  },
  { name: "ComplexBehaviorDefinition", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "condition", type: "FormalExpression" },
      { name: "event", type: "ImplicitThrowEvent" }
    ],
  },
  { name: "ResourceRole", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "resourceRef", type: "Resource", isReference: true },
      { name: "resourceParameterBindings", type: "ResourceParameterBinding", isMany: true },
      { name: "resourceAssignmentExpression", type: "ResourceAssignmentExpression" },
      { name: "name", type: "String", isAttr: true }
    ],
  },
  { name: "ResourceParameterBinding", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "expression", type: "Expression", xml: {"serialize":"xsi:type"} },
      { name: "parameterRef", type: "ResourceParameter", isAttr: true, isReference: true }
    ],
  },
  { name: "ResourceAssignmentExpression", ns: "bpmn", superClass: ["BaseElement"],
    properties: [
      { name: "expression", type: "Expression", xml: {"serialize":"xsi:type"} }
    ],
  },
  { name: "Import", ns: "bpmn", existsInXsd: false,
    properties: [
      { name: "importType", type: "String", isAttr: true },
      { name: "location", type: "String", isAttr: true },
      { name: "namespace", type: "String", isAttr: true }
    ],
  },
  { name: "Definitions", ns: "bpmn", superClass: ["BaseElement"], existsInXsd: false,
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "targetNamespace", type: "String", isAttr: true },
      { name: "expressionLanguage", type: "String", isAttr: true, default: "http://www.w3.org/1999/XPath" },
      { name: "typeLanguage", type: "String", isAttr: true, default: "http://www.w3.org/2001/XMLSchema" },
      { name: "imports", type: "Import", isMany: true },
      { name: "extensions", type: "Extension", isMany: true },
      { name: "rootElements", type: "RootElement", isMany: true },
      { name: "diagrams", type: "bpmndi:BPMNDiagram", isMany: true },
      { name: "exporter", type: "String", isAttr: true },
      { name: "relationships", type: "Relationship", isMany: true },
      { name: "exporterVersion", type: "String", isAttr: true }
    ],
  }
];

/** 语义层中的抽象类型（17 个）：不可实例化，只作为 superClass 存在 */
export const BPMN_ABSTRACT_TYPES: readonly string[] = Object.freeze([
  "Gateway",
  "RootElement",
  "BaseElement",
  "Event",
  "ThrowEvent",
  "CatchEvent",
  "EventDefinition",
  "ConversationNode",
  "FlowElement",
  "FlowElementsContainer",
  "CallableElement",
  "FlowNode",
  "InteractionNode",
  "ChoreographyActivity",
  "Artifact",
  "Activity",
  "LoopCharacteristics",
]);
