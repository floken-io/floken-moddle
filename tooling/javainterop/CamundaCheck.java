/*
 * Java 生态对照物：**Camunda 7 官方 Java 解析器** `camunda-bpmn-model`（与 JS 的
 * camunda-bpmn-moddle 是**两套完全独立的实现**）。
 *
 * 为什么还要它：前面 14 道门禁里的 Java 侧是空的，而企业里跑 BPMN 的主力是 Java 引擎
 * （Camunda 7 / Flowable / Activiti 都是这一族）。它们读的是同一份 XML，
 * 但解析实现、模型抽象、校验规则与 JS 全无共享 —— 是真正的**独立第二意见**。
 *
 * 验什么：
 *   1. 能不能解析（不抛异常）
 *   2. Camunda 自己的校验器 `Bpmn.validateModel()` 报不报错
 *   3. 关键语义是否**按真语义**读回来（不是宽容放行）：
 *      `exclusiveGateway.default` → 真引用；`camunda:assignee` → 真属性；
 *      `scriptTask.scriptFormat/script` → 真字段；`userTask` 的节点数 / 连线数守恒
 *
 * 用法：java -cp "<jars>" CamundaCheck.java <file.bpmn> ...
 * 输出（行协议，供 Node 解析）：
 *   OK   \t<path>\t<details>
 *   FAIL \t<path>\t<reason>
 */
import java.io.File;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import org.camunda.bpm.model.bpmn.Bpmn;
import org.camunda.bpm.model.bpmn.BpmnModelInstance;
import org.camunda.bpm.model.bpmn.instance.Definitions;
import org.camunda.bpm.model.bpmn.instance.ExclusiveGateway;
import org.camunda.bpm.model.bpmn.instance.FlowElement;
import org.camunda.bpm.model.bpmn.instance.Process;
import org.camunda.bpm.model.bpmn.instance.ScriptTask;
import org.camunda.bpm.model.bpmn.instance.SequenceFlow;
import org.camunda.bpm.model.bpmn.instance.UserTask;
import org.camunda.bpm.model.xml.validation.ValidationResults;

public class CamundaCheck {

  static java.io.PrintStream OUT = utf8();

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
        StringBuilder d = new StringBuilder();

        Definitions definitions = mi.getDefinitions();
        d.append("definitions=")
            .append(definitions.getId())
            .append(" targetNamespace=")
            .append(definitions.getTargetNamespace());

        Collection<Process> processes = mi.getModelElementsByType(Process.class);
        d.append(" processes=").append(processes.size());
        for (Process p : processes) {
          d.append(" [")
              .append(p.getId())
              .append(" executable=")
              .append(p.isExecutable())
              .append(" flowElements=")
              .append(p.getFlowElements().size())
              .append("]");
        }

        // 语义要素计数（供守恒比对）
        Collection<FlowElement> flowElements = mi.getModelElementsByType(FlowElement.class);
        Collection<SequenceFlow> flows = mi.getModelElementsByType(SequenceFlow.class);
        Collection<UserTask> userTasks = mi.getModelElementsByType(UserTask.class);
        d.append(" flowElements=")
            .append(flowElements.size())
            .append(" sequenceFlows=")
            .append(flows.size())
            .append(" userTasks=")
            .append(userTasks.size());

        // 默认分支：必须是**真引用**（解析成 SequenceFlow 对象，不是字符串）
        Collection<ExclusiveGateway> gws = mi.getModelElementsByType(ExclusiveGateway.class);
        for (ExclusiveGateway g : gws) {
          SequenceFlow def = g.getDefault();
          d.append(" gateway(")
              .append(g.getId())
              .append(").default=")
              .append(def == null ? "none" : def.getId());
        }

        // camunda 扩展属性：必须是**真属性**
        for (UserTask t : userTasks) {
          if (t.getCamundaAssignee() != null || t.getCamundaCandidateGroups() != null) {
            d.append(" userTask(")
                .append(t.getId())
                .append(").assignee=")
                .append(t.getCamundaAssignee())
                .append(" candidateGroups=")
                .append(t.getCamundaCandidateGroups());
          }
        }

        // scriptTask 的脚本字段
        for (ScriptTask st : mi.getModelElementsByType(ScriptTask.class)) {
          d.append(" scriptTask(")
              .append(st.getId())
              .append(").format=")
              .append(st.getScriptFormat());
        }

        /*
         * Camunda 自己的校验器（Java 生态的 lint）。
         * `Bpmn.validateModel()` 是 void：有错就抛 `ModelValidationException`（里面装着 results）。
         */
        try {
          Bpmn.validateModel(mi);
          d.append(" camundaErrors=0");
        } catch (Throwable ve) {
          int n = -1;
          try {
            Object vr = ve.getClass().getMethod("getValidationResults").invoke(ve);
            n = (Integer) vr.getClass().getMethod("getErrorCount").invoke(vr);
            Object results = vr.getClass().getMethod("getResults").invoke(vr);
            if (results instanceof java.util.Map) {
              for (Object v : ((java.util.Map<?, ?>) results).values()) {
                for (Object r : (java.util.List<?>) v) {
                  OUT.println("  ERR\t" + path + "\t" + String.valueOf(r).replace('\n', ' '));
                }
              }
            }
          } catch (Throwable ignore) {
            /* 反射不到就算了，按 1 条计 */
          }
          OUT.println("FAIL\t" + path + "\tCamunda 校验报错 " + n + " 条：" + String.valueOf(ve).replace('\n', ' '));
          continue;
        }
        OUT.println("OK\t" + path + "\t" + d);
      } catch (Throwable t) {
        OUT.println("FAIL\t" + path + "\t" + String.valueOf(t).replace('\n', ' '));
      }
    }
  }

  /** Windows 上 System.out 走系统编码，中文路径会写成 GBK —— 强制 UTF-8，否则 Node 侧的 key 对不上 */
  static class PrintStreamCompat {
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
  }
}
