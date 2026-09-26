/**
 * BPMN 2.0 枚举字面量（自动生成）
 *
 * ⚠️ **自动生成，请勿手改** —— 改了也会被下一次 gen:spec 覆盖。
 *   要改就改 scripts/gen-bpmn-spec.mjs。
 *
 * 源文件（生成期依赖，MIT，不进 dependencies）：bpmn-moddle 的描述符 JSON。
 * abstract 校正源：OMG Semantic.xsd 原件（complexType@abstract ∪ element@abstract）。
 *
 * 描述符里共 11 个 enumeration，这里全部落盘。
 * @see 流程引擎包文档/01-包需求-floken-moddle.md §3
 */

/** bpmn:ProcessType */
export const BPMN_ProcessType: readonly string[] = Object.freeze([
  "None",
  "Public",
  "Private",
]);

/** bpmn:GatewayDirection */
export const BPMN_GatewayDirection: readonly string[] = Object.freeze([
  "Unspecified",
  "Converging",
  "Diverging",
  "Mixed",
]);

/** bpmn:EventBasedGatewayType */
export const BPMN_EventBasedGatewayType: readonly string[] = Object.freeze([
  "Parallel",
  "Exclusive",
]);

/** bpmn:RelationshipDirection */
export const BPMN_RelationshipDirection: readonly string[] = Object.freeze([
  "None",
  "Forward",
  "Backward",
  "Both",
]);

/** bpmn:ItemKind */
export const BPMN_ItemKind: readonly string[] = Object.freeze([
  "Physical",
  "Information",
]);

/** bpmn:ChoreographyLoopType */
export const BPMN_ChoreographyLoopType: readonly string[] = Object.freeze([
  "None",
  "Standard",
  "MultiInstanceSequential",
  "MultiInstanceParallel",
]);

/** bpmn:AssociationDirection */
export const BPMN_AssociationDirection: readonly string[] = Object.freeze([
  "None",
  "One",
  "Both",
]);

/** bpmn:MultiInstanceBehavior */
export const BPMN_MultiInstanceBehavior: readonly string[] = Object.freeze([
  "None",
  "One",
  "All",
  "Complex",
]);

/** bpmn:AdHocOrdering */
export const BPMN_AdHocOrdering: readonly string[] = Object.freeze([
  "Parallel",
  "Sequential",
]);

/** bpmndi:ParticipantBandKind */
export const BPMNDI_ParticipantBandKind: readonly string[] = Object.freeze([
  "top_initiating",
  "middle_initiating",
  "bottom_initiating",
  "top_non_initiating",
  "middle_non_initiating",
  "bottom_non_initiating",
]);

/** bpmndi:MessageVisibleKind */
export const BPMNDI_MessageVisibleKind: readonly string[] = Object.freeze([
  "initiating",
  "non_initiating",
]);

/** 全部枚举，按 `<ns>:<name>` 索引 */
export const ENUMERATIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "bpmn:ProcessType": BPMN_ProcessType,
  "bpmn:GatewayDirection": BPMN_GatewayDirection,
  "bpmn:EventBasedGatewayType": BPMN_EventBasedGatewayType,
  "bpmn:RelationshipDirection": BPMN_RelationshipDirection,
  "bpmn:ItemKind": BPMN_ItemKind,
  "bpmn:ChoreographyLoopType": BPMN_ChoreographyLoopType,
  "bpmn:AssociationDirection": BPMN_AssociationDirection,
  "bpmn:MultiInstanceBehavior": BPMN_MultiInstanceBehavior,
  "bpmn:AdHocOrdering": BPMN_AdHocOrdering,
  "bpmndi:ParticipantBandKind": BPMNDI_ParticipantBandKind,
  "bpmndi:MessageVisibleKind": BPMNDI_MessageVisibleKind,
});
