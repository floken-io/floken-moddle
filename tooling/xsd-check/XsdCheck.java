/*
 * 官方 OMG BPMN 2.0 XSD 校验器（**只用 JDK 自带的 JAXP**，零第三方依赖）。
 *
 * 为什么单独做它：FR-S14 的「XSD 校验」一直是遗留项，用等价保障顶着。
 * 现在有了官方 XSD 本身（从 Camunda 的 camunda-bpmn-model jar 里取出的
 * OMG 官方发布版：BPMN20.xsd + Semantic.xsd + DI.xsd + BPMNDI.xsd + DC.xsd），
 * 就能**真按规范验**，而不是拿自己的解析器自证。
 *
 * 用法：java XsdCheck.java <xsdDir> <file.bpmn> [file.bpmn ...]
 * 输出（供 Node 解析）：
 *   FILE\t<path>\t<errorCount>
 *   ERR\t<line>:<col>\t<message>
 *   SUMMARY\t<files>\t<totalErrors>
 *
 * 只统计 error / fatalError；warning 不算失败（XSD 的 warning 多为 lax 通配）。
 */
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import javax.xml.XMLConstants;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.Schema;
import javax.xml.validation.SchemaFactory;
import javax.xml.validation.Validator;
import org.xml.sax.ErrorHandler;
import org.xml.sax.SAXParseException;

public class XsdCheck {

  static String one(SAXParseException e) {
    String m = e.getMessage();
    if (m == null) m = "(no message)";
    // 折成单行，避免多行 message 打乱行协议
    return m.replace('\n', ' ').replace('\r', ' ').replace('\t', ' ');
  }

  /**
   * ★ Windows 上 System.out 默认走**系统编码**（CP936），中文路径会被写成 GBK 字节，
   * 调用方按 UTF-8 解就是乱码 —— 行协议的 key 会对不上，看起来像「全部文件都没结果」。
   * 这里强制 UTF-8 输出。
   */
  static PrintStream OUT =
      new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);

  public static void main(String[] args) throws Exception {
    if (args.length < 2) {
      OUT.println("usage: XsdCheck <xsdDir> <file...>");
      System.exit(2);
    }
    String xsdDir = args[0];

    SchemaFactory sf = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI);
    // OMG 官方 XSD 之间用相对 schemaLocation 互引（BPMNDI.xsd / Semantic.xsd / DC.xsd / DI.xsd），
    // 全部同目录 → 交给 JAXP 默认解析即可，无需联网。
    Schema schema = sf.newSchema(new StreamSource(new File(xsdDir, "BPMN20.xsd")));

    int files = 0;
    int totalErrors = 0;

    for (int i = 1; i < args.length; i++) {
      String path = args[i];
      List<String> errs = new ArrayList<>();
      Validator v = schema.newValidator();
      v.setErrorHandler(
          new ErrorHandler() {
            public void warning(SAXParseException e) {
              /* lax 通配的告警不算失败 */
            }

            public void error(SAXParseException e) {
              errs.add("error\t" + e.getLineNumber() + ":" + e.getColumnNumber() + "\t" + one(e));
            }

            public void fatalError(SAXParseException e) {
              errs.add("fatal\t" + e.getLineNumber() + ":" + e.getColumnNumber() + "\t" + one(e));
            }
          });
      try {
        v.validate(new StreamSource(new File(path)));
      } catch (Exception e) {
        // 错误已由 ErrorHandler 收集；这里只兜住非 SAX 的意外
        if (errs.isEmpty()) errs.add("fatal\t0:0\t" + one(new SAXParseException(String.valueOf(e), null)));
      }
      files++;
      totalErrors += errs.size();
      OUT.println("FILE\t" + path + "\t" + errs.size());
      for (String s : errs) OUT.println("ERR\t" + path + "\t" + s);
    }

    OUT.println("SUMMARY\t" + files + "\t" + totalErrors);
  }
}
