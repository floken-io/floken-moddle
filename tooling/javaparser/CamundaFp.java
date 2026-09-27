/*
 * Java 生态对照物之一：**Camunda 7 `camunda-bpmn-model` 的结构指纹提取器**。
 *
 * 与 `../javainterop/CamundaCheck.java` 的分工：那边验「Camunda 认不认 / 校验器报不报」，
 * 这边把 **Camunda 眼里的这张图**完整抽出来，做成一串可比对的行（== 指纹）。
 * 同一份文件在我们这儿转一圈之后，指纹必须一字不差 —— 这才是给引擎的承诺。
 *
 * 行协议（与 FlowableFp / Node 侧完全一致，故各家可交叉比对）：
 *   SRC \t<tool>\t<path>
 *   N   \t<scope>\t<id>\t<type>               节点清单（type = 首字母小写的简单类名）
 *   F   \t<scope>\t<flowId>\t<src>\t<tgt>      连线
 *   G   \t<scope>\t<gwId>\t<defaultFlowId>     网关默认分支
 *   B   \t<scope>\t<bndId>\t<attachedTo>\t<cancelActivity>
 *   C   \t<scope>\t<childId>\t<parentId>       子流程归属
 *   L   \t<scope>\t<laneId>\t<nodeId>          泳道成员
 *   A   \t<collabId>\t<participantId>\t<processRef>
 *   M   \t<mfId>\t<src>\t<tgt>                 消息流
 *   DI  \t<elementId>                          有 shape / edge 的语义元素
 *   FERR\t<tool>\t<path>\t<reason>
 *
 * 用法：java -cp "<camunda jars>" CamundaFp.java <file.bpmn> ...
 */
import java.io.File;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import org.camunda.bpm.model.bpmn.Bpmn;
import org.camunda.bpm.model.bpmn.BpmnModelInstance;
import org.camunda.bpm.model.bpmn.instance.BaseElement;
import org.camunda.bpm.model.bpmn.instance.BoundaryEvent;
import org.camunda.bpm.model.bpmn.instance.Collaboration;
import org.camunda.bpm.model.bpmn.instance.FlowElement;
import org.camunda.bpm.model.bpmn.instance.FlowNode;
import org.camunda.bpm.model.bpmn.instance.InteractionNode;
import org.camunda.bpm.model.bpmn.instance.Lane;
import org.camunda.bpm.model.bpmn.instance.LaneSet;
import org.camunda.bpm.model.bpmn.instance.MessageFlow;
import org.camunda.bpm.model.bpmn.instance.Participant;
import org.camunda.bpm.model.bpmn.instance.Process;
import org.camunda.bpm.model.bpmn.instance.SequenceFlow;
import org.camunda.bpm.model.bpmn.instance.SubProcess;
import org.camunda.bpm.model.bpmn.instance.bpmndi.BpmnEdge;
import org.camunda.bpm.model.bpmn.instance.bpmndi.BpmnShape;

public class CamundaFp {

  static final String TOOL = "camunda";

  static final java.io.PrintStream OUT = utf8();

  static java.io.PrintStream utf8() {
    try {
      return new java.io.PrintStream(
          new java.io.FileOutputStream(java.io.FileDescriptor.out),
          true,
          java.nio.charset.StandardCharsets.UTF_8.name());
    } catch (Exception e) {
      return System.out;
    }
  }

  public static void main(String[] args) {
    for (String path : args) {
      try {
        BpmnModelInstance mi = Bpmn.readModelFromFile(new File(path));
        List<String> lines = new ArrayList<>();

        for (Process p : mi.getModelElementsByType(Process.class)) {
          String scope = String.valueOf(p.getId());
          walk(p.getFlowElements(), scope, null, lines);
          for (LaneSet ls : p.getLaneSets()) emitLaneSet(ls, scope, lines);
        }

        for (Collaboration c : mi.getModelElementsByType(Collaboration.class)) {
          for (Participant pa : c.getParticipants()) {
            Process pr = pa.getProcess();
            lines.add(
                "A\t"
                    + c.getId()
                    + "\t"
                    + pa.getId()
                    + "\t"
                    + (pr == null ? "?" : String.valueOf(pr.getId())));
          }
        }

        for (MessageFlow mf : mi.getModelElementsByType(MessageFlow.class)) {
          InteractionNode s = mf.getSource();
          InteractionNode t = mf.getTarget();
          lines.add(
              "M\t"
                  + mf.getId()
                  + "\t"
                  + (s == null ? "?" : String.valueOf(s.getId()))
                  + "\t"
                  + (t == null ? "?" : String.valueOf(t.getId())));
        }

        for (BpmnShape sh : mi.getModelElementsByType(BpmnShape.class)) {
          BaseElement be = sh.getBpmnElement();
          if (be != null) lines.add("DI\t" + be.getId());
        }
        for (BpmnEdge ed : mi.getModelElementsByType(BpmnEdge.class)) {
          BaseElement be = ed.getBpmnElement();
          if (be != null) lines.add("DI\t" + be.getId());
        }

        OUT.println("SRC\t" + TOOL + "\t" + path);
        for (String l : lines) OUT.println(l);
      } catch (Throwable t) {
        OUT.println("FERR\t" + TOOL + "\t" + path + "\t" + String.valueOf(t).replace('\n', ' '));
      }
    }
  }

  static void emitLaneSet(LaneSet ls, String scope, List<String> out) {
    for (Lane lane : ls.getLanes()) {
      String laneId = String.valueOf(lane.getId());
      Collection<FlowNode> refs = lane.getFlowNodeRefs();
      if (refs == null || refs.isEmpty()) out.add("L\t" + scope + "\t" + laneId + "\t-");
      else for (FlowNode fn : refs) out.add("L\t" + scope + "\t" + laneId + "\t" + fn.getId());
      // 嵌套泳道（lane → childLaneSet → lanes…）
      Object child = invoke(lane, "getChildLaneSet");
      if (child instanceof LaneSet) emitLaneSet((LaneSet) child, scope, out);
    }
  }

  static void walk(
      Collection<FlowElement> els, String scope, String parentId, List<String> out) {
    for (FlowElement fe : els) {
      String id = String.valueOf(fe.getId());
      out.add("N\t" + scope + "\t" + id + "\t" + typeOf(fe));
      if (parentId != null) out.add("C\t" + scope + "\t" + id + "\t" + parentId);

      if (fe instanceof SequenceFlow) {
        SequenceFlow sf = (SequenceFlow) fe;
        out.add(
            "F\t"
                + scope
                + "\t"
                + id
                + "\t"
                + safe(sf.getSource())
                + "\t"
                + safe(sf.getTarget()));
      }

      // 默认分支：各子类型签名不同（Gateway / Activity / AdHocSubProcess），一律反射取
      Object def = invoke(fe, "getDefault");
      String defId =
          def instanceof SequenceFlow
              ? String.valueOf(((SequenceFlow) def).getId())
              : (def instanceof BaseElement ? String.valueOf(((BaseElement) def).getId()) : null);
      if (defId != null) out.add("G\t" + scope + "\t" + id + "\t" + defId);

      if (fe instanceof BoundaryEvent) {
        BoundaryEvent be = (BoundaryEvent) fe;
        BaseElement attached = be.getAttachedTo();
        out.add(
            "B\t"
                + scope
                + "\t"
                + id
                + "\t"
                + (attached == null ? "?" : String.valueOf(attached.getId()))
                + "\t"
                + be.cancelActivity());
      }

      if (fe instanceof SubProcess)
        walk(((SubProcess) fe).getFlowElements(), scope, fe.getId(), out);
    }
  }

  static String safe(BaseElement e) {
    return e == null ? "?" : String.valueOf(e.getId());
  }

  static Object invoke(Object target, String method) {
    try {
      return target.getClass().getMethod(method).invoke(target);
    } catch (Throwable t) {
      return null;
    }
  }

  /**
   * 类型名优先取 **XSD 类型名**（`getElementType().getTypeName()` → `startEvent` / `userTask`），
   * 而不是实现类的简单名（`StartEventImpl`）—— 后者各家不一致，没法跨工具比对。
   */
  static String typeOf(Object e) {
    Object t = invoke(e, "getElementType");
    Object n = t == null ? null : invoke(t, "getTypeName");
    if (n != null) return String.valueOf(n);
    String s = String.valueOf(e.getClass().getSimpleName());
    s = s.endsWith("Impl") ? s.substring(0, s.length() - 4) : s;
    return lower(s);
  }

  static String lower(String s) {
    if (s == null || s.isEmpty()) return s;
    return Character.toLowerCase(s.charAt(0)) + s.substring(1);
  }
}
