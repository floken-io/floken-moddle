/**
 * BPMN 图形交换（DI）类型表 —— 24 类型 / 53 属性（自动生成）
 *
 * ⚠️ **自动生成，请勿手改** —— 改了也会被下一次 gen:spec 覆盖。
 *   要改就改 scripts/gen-bpmn-spec.mjs。
 *
 * 源文件（生成期依赖，MIT，不进 dependencies）：bpmn-moddle 的描述符 JSON。
 * abstract 校正源：OMG Semantic.xsd 原件（complexType@abstract ∪ element@abstract）。
 *
 * 与语义层**分开记账**：对外口径「BPMN 137 类型 / 318 属性」**只算语义层**，
 * 图形交换是另外的 24 类型。两者混报就会把 137 说成 161。
 * @see 流程引擎包文档/01-包需求-floken-moddle.md §3
 */

import type { BpmnTypeSpec, PropertySpec } from './spec-types.js';

/** 复用同一个冻结空数组，避免每个无属性类型各建一份 */
const EMPTY_PROPERTIES: readonly PropertySpec[] = Object.freeze([]);

/** bpmndi：http://www.omg.org/spec/BPMN/20100524/DI */
const BPMNDI_GROUP: readonly BpmnTypeSpec[] = [
  { name: "BPMNDiagram", ns: "bpmndi", superClass: ["di:Diagram"], existsInXsd: false,
    properties: [
      { name: "plane", type: "BPMNPlane", redefines: "di:Diagram#rootElement" },
      { name: "labelStyle", type: "BPMNLabelStyle", isMany: true }
    ],
  },
  { name: "BPMNPlane", ns: "bpmndi", superClass: ["di:Plane"], existsInXsd: false,
    properties: [
      { name: "bpmnElement", type: "bpmn:BaseElement", isAttr: true, isReference: true, redefines: "di:DiagramElement#modelElement" }
    ],
  },
  { name: "BPMNShape", ns: "bpmndi", superClass: ["di:LabeledShape"], existsInXsd: false,
    properties: [
      { name: "bpmnElement", type: "bpmn:BaseElement", isAttr: true, isReference: true, redefines: "di:DiagramElement#modelElement" },
      { name: "isHorizontal", type: "Boolean", isAttr: true },
      { name: "isExpanded", type: "Boolean", isAttr: true },
      { name: "isMarkerVisible", type: "Boolean", isAttr: true },
      { name: "label", type: "BPMNLabel" },
      { name: "isMessageVisible", type: "Boolean", isAttr: true },
      { name: "participantBandKind", type: "ParticipantBandKind", isAttr: true },
      { name: "choreographyActivityShape", type: "BPMNShape", isAttr: true, isReference: true }
    ],
  },
  { name: "BPMNEdge", ns: "bpmndi", superClass: ["di:LabeledEdge"], existsInXsd: false,
    properties: [
      { name: "label", type: "BPMNLabel" },
      { name: "bpmnElement", type: "bpmn:BaseElement", isAttr: true, isReference: true, redefines: "di:DiagramElement#modelElement" },
      { name: "sourceElement", type: "di:DiagramElement", isAttr: true, isReference: true, redefines: "di:Edge#source" },
      { name: "targetElement", type: "di:DiagramElement", isAttr: true, isReference: true, redefines: "di:Edge#target" },
      { name: "messageVisibleKind", type: "MessageVisibleKind", isAttr: true, default: "initiating" }
    ],
  },
  { name: "BPMNLabel", ns: "bpmndi", superClass: ["di:Label"], existsInXsd: false,
    properties: [
      { name: "labelStyle", type: "BPMNLabelStyle", isAttr: true, isReference: true, redefines: "di:DiagramElement#style" }
    ],
  },
  { name: "BPMNLabelStyle", ns: "bpmndi", superClass: ["di:Style"], existsInXsd: false,
    properties: [
      { name: "font", type: "dc:Font" }
    ],
  }
];

/** di：http://www.omg.org/spec/DD/20100524/DI */
const DI_GROUP: readonly BpmnTypeSpec[] = [
  { name: "DiagramElement", ns: "di", isAbstract: true, existsInXsd: false,
    properties: [
      { name: "id", type: "String", isAttr: true, isId: true },
      { name: "extension", type: "Extension" },
      { name: "owningDiagram", type: "Diagram", isReference: true, isVirtual: true, isReadOnly: true },
      { name: "owningElement", type: "DiagramElement", isReference: true, isVirtual: true, isReadOnly: true },
      { name: "modelElement", type: "Element", isReference: true, isVirtual: true, isReadOnly: true },
      { name: "style", type: "Style", isReference: true, isVirtual: true, isReadOnly: true },
      { name: "ownedElement", type: "DiagramElement", isMany: true, isVirtual: true, isReadOnly: true }
    ],
  },
  { name: "Node", ns: "di", superClass: ["DiagramElement"], isAbstract: true, existsInXsd: false, properties: EMPTY_PROPERTIES },
  { name: "Edge", ns: "di", superClass: ["DiagramElement"], isAbstract: true, existsInXsd: false,
    properties: [
      { name: "source", type: "DiagramElement", isReference: true, isVirtual: true, isReadOnly: true },
      { name: "target", type: "DiagramElement", isReference: true, isVirtual: true, isReadOnly: true },
      { name: "waypoint", type: "dc:Point", isMany: true, xml: {"serialize":"xsi:type"} }
    ],
  },
  { name: "Diagram", ns: "di", isAbstract: true, existsInXsd: false,
    properties: [
      { name: "id", type: "String", isAttr: true, isId: true },
      { name: "rootElement", type: "DiagramElement", isVirtual: true, isReadOnly: true },
      { name: "name", type: "String", isAttr: true },
      { name: "documentation", type: "String", isAttr: true },
      { name: "resolution", type: "Real", isAttr: true },
      { name: "ownedStyle", type: "Style", isMany: true, isVirtual: true, isReadOnly: true }
    ],
  },
  { name: "Shape", ns: "di", superClass: ["Node"], isAbstract: true, existsInXsd: false,
    properties: [
      { name: "bounds", type: "dc:Bounds" }
    ],
  },
  { name: "Plane", ns: "di", superClass: ["Node"], isAbstract: true, existsInXsd: false,
    properties: [
      { name: "planeElement", type: "DiagramElement", isMany: true, subsettedProperty: "DiagramElement-ownedElement" }
    ],
  },
  { name: "LabeledEdge", ns: "di", superClass: ["Edge"], isAbstract: true, existsInXsd: false,
    properties: [
      { name: "ownedLabel", type: "Label", isMany: true, isVirtual: true, isReadOnly: true, subsettedProperty: "DiagramElement-ownedElement" }
    ],
  },
  { name: "LabeledShape", ns: "di", superClass: ["Shape"], isAbstract: true, existsInXsd: false,
    properties: [
      { name: "ownedLabel", type: "Label", isMany: true, isVirtual: true, isReadOnly: true, subsettedProperty: "DiagramElement-ownedElement" }
    ],
  },
  { name: "Label", ns: "di", superClass: ["Node"], isAbstract: true, existsInXsd: false,
    properties: [
      { name: "bounds", type: "dc:Bounds" }
    ],
  },
  { name: "Style", ns: "di", isAbstract: true, existsInXsd: false,
    properties: [
      { name: "id", type: "String", isAttr: true, isId: true }
    ],
  },
  { name: "Extension", ns: "di",
    properties: [
      { name: "values", type: "Element", isMany: true }
    ],
  }
];

/** dc：http://www.omg.org/spec/DD/20100524/DC */
const DC_GROUP: readonly BpmnTypeSpec[] = [
  { name: "Boolean", ns: "dc", existsInXsd: false, properties: EMPTY_PROPERTIES },
  { name: "Integer", ns: "dc", existsInXsd: false, properties: EMPTY_PROPERTIES },
  { name: "Real", ns: "dc", existsInXsd: false, properties: EMPTY_PROPERTIES },
  { name: "String", ns: "dc", existsInXsd: false, properties: EMPTY_PROPERTIES },
  { name: "Font", ns: "dc", existsInXsd: false,
    properties: [
      { name: "name", type: "String", isAttr: true },
      { name: "size", type: "Real", isAttr: true },
      { name: "isBold", type: "Boolean", isAttr: true },
      { name: "isItalic", type: "Boolean", isAttr: true },
      { name: "isUnderline", type: "Boolean", isAttr: true },
      { name: "isStrikeThrough", type: "Boolean", isAttr: true }
    ],
  },
  { name: "Point", ns: "dc", existsInXsd: false,
    properties: [
      { name: "x", type: "Real", isAttr: true, default: "0" },
      { name: "y", type: "Real", isAttr: true, default: "0" }
    ],
  },
  { name: "Bounds", ns: "dc", existsInXsd: false,
    properties: [
      { name: "x", type: "Real", isAttr: true, default: "0" },
      { name: "y", type: "Real", isAttr: true, default: "0" },
      { name: "width", type: "Real", isAttr: true },
      { name: "height", type: "Real", isAttr: true }
    ],
  }
];


/** 图形交换层合计（bpmndi + di + dc） */
export const DI_TYPES: readonly BpmnTypeSpec[] = [
  ...BPMNDI_GROUP,
  ...DI_GROUP,
  ...DC_GROUP,
];

/** 按命名空间分组的图形类型，便于按 ns 单独取用 */
export const DI_TYPE_GROUPS: Readonly<Record<string, readonly BpmnTypeSpec[]>> = Object.freeze({
  "bpmndi": BPMNDI_GROUP,
  "di": DI_GROUP,
  "dc": DC_GROUP,
});
