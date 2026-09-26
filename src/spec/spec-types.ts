// spec 层的数据形状。**手写**，不参与生成 —— 生成产物 import 它们。
// @see 流程引擎包文档/01-包需求-floken-moddle.md §3.3

/** 描述符的四个命名空间前缀 */
export type BpmnNs = 'bpmn' | 'bpmndi' | 'di' | 'dc';

/**
 * 一条属性定义。
 *
 * 字段名沿用 bpmn-moddle 描述符的命名（`isAttr` / `isMany` / …），
 * **刻意不改别名** —— 对照上游描述符排查时，同名比可读更重要。
 */
export interface PropertySpec {
  /** 属性名（BPMN 规范名，小驼峰） */
  name: string;
  /** 值类型：基本类型（`String`/`Boolean`/`Integer`/`Real`/`Element`）或类型名 */
  type: string;
  /** XML 里写成 attribute 而非子元素 */
  isAttr?: true;
  /** 集合（0..*） */
  isMany?: true;
  /** 引用另一个元素（按 id 指向）而非含其内容 */
  isReference?: true;
  /** 虚拟属性：引擎/read API 才有，XML 里不存在 */
  isVirtual?: true;
  isReadOnly?: true;
  /** 该属性承担元素 id 的角色 */
  isId?: true;
  /** 值写在元素正文里（如 `<conditionExpression>x > 1</conditionExpression>`） */
  isBody?: true;
  isUnique?: true;
  default?: string | number | boolean;
  /**
   * XML 序列化提示，描述符里实际只有这两种取值：
   * - `'xsi:type'`：写 XML 时要带 `xsi:type`（多态引用的场合，如 `conditionExpression`）
   * - `'property'`：作为**子元素**序列化而非 attribute（如 `Activity.ioSpecification`）
   */
  xml?: { serialize?: 'xsi:type' | 'property' };
  /** 重定义继承来的同名属性，值形如 `'Activity#loopCharacteristics'` */
  redefines?: string;
  replaces?: string;
  subsettedProperty?: string;
}

export interface BpmnTypeSpec {
  /** 类型名。`bpmn` 命名空间下它等于 BPMN 元素名的**帕斯卡**写法（`userTask` → `UserTask`） */
  name: string;
  ns: BpmnNs;
  /** 父类，可能多重继承。**不含祖先**，祖先要自己走 `INDEX` 展开 */
  superClass?: readonly string[];
  /** 抽象：不可实例化，只作为 superClass 存在。裁定规则见生成脚本 `DESC_ONLY_ABSTRACT` */
  isAbstract?: true;
  /**
   * XSD 里**没有**对应的 complexType —— 它是描述符为了复用而引入的中间类型
   * （`FlowElementsContainer` / `InteractionNode` / `ItemAwareElement`）。
   * 省略表示「XSD 里有」。
   */
  existsInXsd?: false;
  /** 自有属性。**不含继承来的** —— 继承展开走 {@link effectiveProperties} */
  properties: readonly PropertySpec[];
}
