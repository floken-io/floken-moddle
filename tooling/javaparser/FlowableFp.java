/*
 * Java 生态对照物之二：**Flowable `flowable-bpmn-converter` 7.1.0 的结构指纹提取器**。
 *
 * 为什么在 Camunda 之外还要第二家 Java：
 *   Camunda 7 与 Flowable 虽同宗，但 **解析器 / 模型抽象 / XSD 副本都是各自一份**
 *   （Flowable jar 里自带 `org/flowable/impl/bpmn/parser/BPMN20.xsd`，与 Camunda jar 里那份是独立来源）。
 *   两家都认、且认出来的图一模一样，才是真的站得住。
 *
 * 行协议与 CamundaFp 完全一致，唯二差别（工具能力所致，比对时按工具各自口径）：
 *   - `A`（participant/pool）没有 collaboration id → 写成 `-`
 *   - `C`（子流程归属）由递归 subProcess.getFlowElements() 得出
 *
 * 用法：java -cp "<flowable jars>" FlowableFp.java <file.bpmn> ...
 */
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.flowable.bpmn.converter.BpmnXMLConverter;
import org.flowable.bpmn.model.BoundaryEvent;
import org.flowable.bpmn.model.BpmnModel;
import org.flowable.bpmn.model.FlowElement;
import org.flowable.bpmn.model.Gateway;
import org.flowable.bpmn.model.Lane;
import org.flowable.bpmn.model.MessageFlow;
import org.flowable.bpmn.model.Pool;
import org.flowable.bpmn.model.SequenceFlow;
import org.flowable.bpmn.model.SubProcess;

public class FlowableFp {

  static final String TOOL = "flowable";

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
        final File file = new File(path);
        // validateSchema=false：XSD 那件事由第十五道 check:xsd 单独钉死，这里只比结构
        BpmnModel model =
            new BpmnXMLConverter()
                .convertToBpmnModel(
                    new org.flowable.common.engine.api.io.InputStreamProvider() {
                      @Override
                      public InputStream getInputStream() {
                        try {
                          return new FileInputStream(file);
                        } catch (Exception e) {
                          throw new RuntimeException(e);
                        }
                      }
                    },
                    false,
                    false);

        List<String> lines = new ArrayList<>();
        for (org.flowable.bpmn.model.Process p : model.getProcesses()) {
          String scope = String.valueOf(p.getId());
          Set<String> seen = new HashSet<>();
          walk(p.getFlowElements(), scope, null, seen, lines);
          for (Lane lane : p.getLanes()) {
            List<String> refs = lane.getFlowReferences();
            if (refs == null || refs.isEmpty())
              lines.add("L\t" + scope + "\t" + lane.getId() + "\t-");
            else for (String r : refs) lines.add("L\t" + scope + "\t" + lane.getId() + "\t" + r);
          }
        }

        for (Pool pool : model.getPools())
          lines.add(
              "A\t-\t" + pool.getId() + "\t" + String.valueOf(pool.getProcessRef()));

        for (Map.Entry<String, MessageFlow> e : model.getMessageFlows().entrySet()) {
          MessageFlow mf = e.getValue();
          lines.add(
              "M\t"
                  + mf.getId()
                  + "\t"
                  + String.valueOf(mf.getSourceRef())
                  + "\t"
                  + String.valueOf(mf.getTargetRef()));
        }

        /*
         * ★ `null` 这个 key 要滤掉：Flowable 解析「指向它认不出的元素的 shape」时
         * 会把 locationMap 的 key 写成 null（`String.valueOf(null)` → "null"）。
         * MIWG C.7.0 实证：有一个 shape 指向 `<collaboration>`，Flowable 不建模 collaboration
         * → 多出一条 `DI null`。**那个 shape 我们原样写回、一点没丢**，
         * 这条只是 Flowable 内部的记账噪声，留着会让"前后一致"误判。
         */
        for (String id : model.getLocationMap().keySet())
          if (id != null && !id.equals("null")) lines.add("DI\t" + id);
        for (String id : model.getFlowLocationMap().keySet())
          if (id != null && !id.equals("null")) lines.add("DI\t" + id);

        OUT.println("SRC\t" + TOOL + "\t" + path);
        for (String l : lines) OUT.println(l);
      } catch (Throwable t) {
        OUT.println("FERR\t" + TOOL + "\t" + path + "\t" + String.valueOf(t).replace('\n', ' '));
      }
    }
  }

  /**
   * 遍历 flow elements。
   * Flowable 的 `Process.getFlowElements()` 各家版本行为不同（有的把子元素一并扁出来），
   * 所以用 `seen` 按 id 去重，穿透与否都不影响最终集合。
   */
  static void walk(
      Collection<FlowElement> els, String scope, String parentId, Set<String> seen, List<String> out) {
    for (FlowElement fe : els) {
      String id = String.valueOf(fe.getId());
      if (!seen.add(scope + "|" + id)) continue;
      out.add("N\t" + scope + "\t" + id + "\t" + lower(fe.getClass().getSimpleName()));
      if (parentId != null) out.add("C\t" + scope + "\t" + id + "\t" + parentId);

      if (fe instanceof SequenceFlow) {
        SequenceFlow sf = (SequenceFlow) fe;
        out.add(
            "F\t"
                + scope
                + "\t"
                + id
                + "\t"
                + String.valueOf(sf.getSourceRef())
                + "\t"
                + String.valueOf(sf.getTargetRef()));
      }

      if (fe instanceof Gateway) {
        String def = ((Gateway) fe).getDefaultFlow();
        if (def != null) out.add("G\t" + scope + "\t" + id + "\t" + def);
      }

      if (fe instanceof BoundaryEvent) {
        BoundaryEvent be = (BoundaryEvent) fe;
        String attached = invoke(be, "getAttachedToRefId");
        Object cancel = invoke(be, "isCancelActivity");
        out.add(
            "B\t"
                + scope
                + "\t"
                + id
                + "\t"
                + (attached == null ? "?" : attached)
                + "\t"
                + String.valueOf(cancel));
      }

      if (fe instanceof SubProcess)
        walk(((SubProcess) fe).getFlowElements(), scope, fe.getId(), seen, out);
    }
  }

  static String invoke(Object target, String method) {
    try {
      Object r = target.getClass().getMethod(method).invoke(target);
      return r == null ? null : String.valueOf(r);
    } catch (Throwable t) {
      return null;
    }
  }

  static String lower(String s) {
    if (s == null || s.isEmpty()) return s;
    return Character.toLowerCase(s.charAt(0)) + s.substring(1);
  }
}
