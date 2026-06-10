# Java Class Analyzer MCP Server

> 当前项目地址：[yudongf/java-class-analyzer-mcp-server](https://github.com/yudongf/java-class-analyzer-mcp-server)（基于 [handsomestWei/java-class-analyzer-mcp-server](https://github.com/handsomestWei/java-class-analyzer-mcp-server) 改造）。
>
> 在保留原有 MCP 工具能力的基础上，重点完善了 **Windows / macOS 跨平台支持** 与 **CFR 反编译工具的查找与加载逻辑**，使其可直接在 macOS / Linux 环境下稳定运行。

一个基于Model Context Protocol (MCP)的Java类分析服务，可以扫描Maven项目依赖、反编译Java类文件、获取class方法列表等详细信息，并提供给LLM进行代码分析。

## 适用场景
Cursor等AI工具直接生成调用二方（内部调用）、三方包（外部调用）接口的代码，但因AI无法读取未在当前工程中打开的依赖源码，导致生成的代码错误频出，甚至出现幻觉式编码。

为解决此问题，一般会直接拷贝源码内容喂给LLM；或者先将源码文件放到当前工程内，再在对话中引用。

而使用本地反编译MCP方案最有效，能精准解析jar包中的类与方法，显著提升代码生成的准确性和可用性。

## 功能特性

- **🚀使用方便**：mcp服务基于TypeScript实现，使用npm打包，方便分发和安装，弱环境依赖。
- 🔍 **依赖扫描**: 自动扫描Maven项目的所有依赖JAR包
- 📦 **类索引**: 建立类全名到JAR包路径的映射索引
- 🧭 **智能类名匹配**: 当未找到精确全限定类名时，按 simpleName 进行模糊匹配，并对包含匹配的候选给出友好提示
- 🔄 **反编译**: 使用CFR工具（已内置有）实时反编译.class文件为Java源码
- 📊 **类分析**: 分析Java类的结构、方法、字段、继承关系等
- 💾 **智能缓存**: 按包名结构缓存反编译结果，支持缓存控制
- 🚀 **自动索引**: 执行分析前自动检查并创建索引
- ⚙️ **灵活配置**: 支持外部指定CFR工具路径，并通过 `CFR_PATH` 环境变量优先加载
- 🖥️ **跨平台兼容**: 已修复 macOS / Linux 下 `javap` 调用问题，自动按平台选择可执行文件
- 🤖 **LLM集成**: 通过MCP协议为LLM提供Java代码分析能力

## 本次更新内容（v1.0.1）

> 相对于原 [handsomestWei/java-class-analyzer-mcp-server](https://github.com/handsomestWei/java-class-analyzer-mcp-server) 的改造点。

### 一、Windows 与 macOS 跨平台支持

原版本在多处硬编码了 Windows 路径与可执行文件名，导致在 macOS / Linux 下无法运行。本次改造实现了真正的跨平台兼容：

- **`javap` 调用按平台选择**：[`JavaClassAnalyzer.getJavapCommand()`](src/analyzer/JavaClassAnalyzer.ts:332) 不再硬编码 `javap.exe`，改为依据 `process.platform` 自动选择：
    - Windows: `${JAVA_HOME}/bin/javap.exe`
    - macOS / Linux: `${JAVA_HOME}/bin/javap`
    - 未设置 `JAVA_HOME` 时回退到 `PATH` 中的 `javap`
- **临时目录改用系统 tmp**：[`DecompilerService.extractClassFile()`](src/decompiler/DecompilerService.ts:121) 由原来固定写入 `process.cwd()/.mcp-class-temp` 改为优先使用 `os.tmpdir()/mcp-class-temp`，避免不同平台下污染工作目录;当 MCP 进程下 `os.tmpdir()` 异常返回 `/` 或空时，回退到用户主目录(`HOME` / `USERPROFILE`)下的 `.mcp-class-temp/`。
- **示例配置跨平台化**：[`mcp-server-config.json`](mcp-server-config.json) 由原 Windows 绝对路径(`D:/ws-git/...`) + `node` 启动方式，改为推荐的全局命令 `java-class-analyzer-mcp start`，环境变量改用占位符（`${HOME}/.m2/repository`、`${JAVA_HOME}`、新增 `CFR_PATH`），Windows / macOS 通用。

| 系统 | `JAVA_HOME` 示例 | `MAVEN_REPO` 示例 | `javap` 实际调用 |
| --- | --- | --- | --- |
| Windows | `C:/Program Files/Java/jdk-11` | `D:/maven/repository` | `${JAVA_HOME}/bin/javap.exe` |
| macOS | `/Library/Java/JavaVirtualMachines/jdk-11.jdk/Contents/Home` | `${HOME}/.m2/repository` | `${JAVA_HOME}/bin/javap` |
| Linux | `/usr/lib/jvm/java-11-openjdk` | `${HOME}/.m2/repository` | `${JAVA_HOME}/bin/javap` |

### 二、CFR 反编译工具处理逻辑增强

原版本仅从项目目录或 `CLASSPATH` 查找 CFR，配置不灵活、缺失时报错信息也不友好。本次改造重��了 CFR 查找与失败提示逻辑：

- **四级优先级查找**（[`DecompilerService.findCfrJar()`](src/decompiler/DecompilerService.ts:231)，每一步都会打印明确日志便于排查）：
    1. `CFR_PATH` 环境变量（最高优先级，推荐方式）
    2. 用户主目录下匹配 `cfr-*.jar` 正则的文件（`HOME` / `USERPROFILE`，跨平台）
    3. 项目 `lib/` 目录及当前工作目录等常见路径
    4. `CLASSPATH` 环境变量中包含 `cfr` 的条目
- **CFR 缺失时的友好错误**：[`DecompilerService.decompileWithCfr()`](src/decompiler/DecompilerService.ts:189) 在未找到 CFR 时不再抛出笼统报错，而是直接列出 3 种可用配置方式，引导用户快速修复：

    ```text
    未找到CFR反编译工具。请通过以下方式之一配置：
      1. 设置 CFR_PATH 环境变量指向 cfr jar 文件路径
      2. 将 cfr jar 放到 ~/cfr-*.jar（用户主目录）
      3. 将 cfr jar 放到项目 lib/ 目录下
    ```

- **运行时仍支持 `cfrPath` 参数覆盖**：通过 `decompile_class` 工具调用时显式传入 `cfrPath`，可临时指定 CFR jar 路径，优先级高于上述自动查找。

**推荐配置方式**：

- Windows：下载 `cfr-0.152.jar` 后设置环境变量 `CFR_PATH=D:\tools\cfr-0.152.jar`，或放到 `%USERPROFILE%\cfr-0.152.jar`。
- macOS / Linux：`export CFR_PATH=$HOME/cfr-0.152.jar`，或直接将 jar 放到 `~/cfr-0.152.jar`，无需任何额外配置即可被自动识别。

**cfr下载地址**
[leibnitz27/cfr](https://github.com/leibnitz27/cfr/releases)

### 三、其它改造

- **类名查找支持模糊匹配**：[`DependencyScanner.findJarForClass()`](src/scanner/DependencyScanner.ts:254) 精确匹配失败后会按 simpleName 唯一匹配、多候选报错、包含匹配三级回退，输入短类名也能定位。
- **版本号统一**：[`src/cli.ts`](src/cli.ts:11) 与 [`src/index.ts`](src/index.ts:23) 由 `1.0.0` 更新为 `1.0.1`，与 `package.json` 对齐。

## 使用示例
### 在IDE中注册mcp服务
![工具列表](./doc/mcp-tools.jpg)

### 在智能体对话中使用mcp
![示例](./doc/mcp-use-case.jpg)

## 使用说明

```

#### 从源码安装

```bash
git clone https://github.com/yudongf/java-class-analyzer-mcp-server.git
cd java-class-analyzer-mcp-server
npm install
npm run build
```

### MCP服务配置

#### 方法1：使用生成的配置（推荐）

运行以下命令生成配置模板：
```bash
java-class-analyzer-mcp config -o mcp-client-config.json
```

然后将生成的配置内容添加到你的MCP客户端配置文件中。

#### 方法2：手动配置

参考以下配置示例，添加到MCP客户端配置文件中：

**全局安装后的配置：**
```json
{
    "mcpServers": {
        "java-class-analyzer": {
            "command": "java-class-analyzer-mcp",
            "args": ["start"],
            "env": {
                "NODE_ENV": "production",
                "MAVEN_REPO": "D:/maven/repository",
                "JAVA_HOME": "C:/Program Files/Java/jdk-11",
                "CFR_PATH": "D:/tools/cfr-0.152.jar"
            }
        }
    }
}
```

**本地安装后的配置：**
```json
{
    "mcpServers": {
        "java-class-analyzer": {
            "command": "node",
            "args": [
                "node_modules/java-class-analyzer-mcp-server/dist/index.js"
            ],
            "env": {
                "NODE_ENV": "production",
                "MAVEN_REPO": "D:/maven/repository",
                "JAVA_HOME": "C:/Program Files/Java/jdk-11",
                "CFR_PATH": "D:/tools/cfr-0.152.jar"
            }
        }
    }
}
```

#### 参数说明
- `command`: 运行MCP服务器的命令，这里使用 `node`
- `args`: 传递给Node.js的参数，指向`npm run build`编译后的dist文件夹内文件
- `env`: 环境变量设置

#### 环境变量说明
- `NODE_ENV`: 运行环境标识
  - `production`: 生产环境，减少日志输出，启用性能优化
  - `development`: 开发环境，输出详细调试信息
  - `test`: 测试环境
- `MAVEN_REPO`: Maven本地仓库路径（可选）
  - 如果设置，程序会使用指定的仓库路径扫描JAR包
  - 如果未设置，程序会使用默认的 `~/.m2/repository` 路径
- `JAVA_HOME`: Java安装路径（可选）
  - 如果设置，程序会使用 `${JAVA_HOME}/bin/java` 执行Java命令（用于CFR反编译）
  - 如果未设置，程序会使用PATH中的 `java` 命令
- `CFR_PATH`: CFR反编译工具的路径（可选，程序会自动查找）
  - 查找顺序为：`CFR_PATH` → 用户主目录 `cfr-*.jar` → 项目 `lib/` 目录 → `CLASSPATH`

### 可用的工具

#### 1. scan_dependencies
扫描Maven项目的所有依赖，建立类名到JAR包的映射索引。

**参数:**
- `projectPath` (string): Maven项目根目录路径
- `forceRefresh` (boolean, 可选): 是否强制刷新索引，默认false

**示例:**
```json
{
  "name": "scan_dependencies",
  "arguments": {
    "projectPath": "/path/to/your/maven/project",
    "forceRefresh": false
  }
}
```

#### 2. decompile_class
反编译指定的Java类文件，返回Java源码。

**参数:**
- `className` (string): 要反编译的Java类全名，如：com.example.QueryBizOrderDO
- `projectPath` (string): Maven项目根目录路径
- `useCache` (boolean, 可选): 是否使用缓存，默认true。避免每次都重复生成。
- `cfrPath` (string, 可选): CFR反编译工具的jar包路径。已内置有，可以额外指定版本。

**示例:**
```json
{
  "name": "decompile_class",
  "arguments": {
    "className": "com.example.QueryBizOrderDO",
    "projectPath": "/path/to/your/maven/project",
    "useCache": true,
    "cfrPath": "/path/to/cfr-0.152.jar"
  }
}
```

#### 3. analyze_class
分析Java类的结构、方法、字段等信息。

**参数:**
- `className` (string): 要分析的Java类全名
- `projectPath` (string): Maven项目根目录路径

**示例:**
```json
{
  "name": "analyze_class",
  "arguments": {
    "className": "com.example.QueryBizOrderDO",
    "projectPath": "/path/to/your/maven/project",
  }
}
```

### 缓存文件
在当前工程，会生成以下缓存目录和文件。
- `.mcp-class-index.json`: 类索引缓存文件
- `.mcp-decompile-cache/`: 反编译结果缓存目录（按包名结构）

> 说明：从 v1.0.1 起，临时 class 提取目录已迁移到系统临时目录（`os.tmpdir()/mcp-class-temp`），不再污染项目根目录的 `.mcp-class-temp/`；仅当系统临时目录不可用时，才回退到用户主目录下的 `.mcp-class-temp/`。

## 工作流程

1. **自动索引**: 首次调用`analyze_class`或`decompile_class`时，自动检查并创建索引
2. **智能缓存**: 反编译结果按包名结构缓存，支持缓存控制
3. **分析类**: 使用`analyze_class`或`decompile_class`获取类的详细信息
4. **LLM分析**: 将反编译的源码提供给LLM进行代码分析

## 技术架构

### 核心组件

- **DependencyScanner**: 负责扫描Maven依赖和建立类索引
- **DecompilerService**: 负责反编译.class文件
- **JavaClassAnalyzer**: 负责分析Java类结构
- **MCP Server**: 提供标准化的MCP接口

### 依赖扫描流程

1. 执行`mvn dependency:tree`获取依赖树
2. 解析每个JAR包，提取所有.class文件
3. 建立"类全名 -> JAR包路径"的映射索引
4. 缓存索引到`.mcp-class-index.json`文件

### 反编译流程

1. 根据类名查找对应的JAR包路径
2. 检查缓存，如果存在且启用缓存则直接返回
3. 从JAR包中提取.class文件到`.mcp-class-temp`目录（按包名结构）
4. 使用CFR工具反编译.class文件
5. 保存反编译结果到缓存`.mcp-decompile-cache`目录（按包名结构）
6. 返回Java源码

## 故障排除

### 常见问题

1. **Maven命令失败**
   - 确保Maven已安装并在PATH中
   - 检查项目是否有有效的pom.xml文件

2. **CFR反编译失败**
   - 确保CFR jar包已下载（支持任意版本号）
   - 检查Java环境是否正确配置
   - 可通过`cfrPath`参数指定CFR路径
   - 也可通过 `CFR_PATH` 环境变量或将 `cfr-*.jar` 放到用户主目录 / 项目 `lib/` 下自动加载

3. **类未找到**
   - 程序会自动检查并创建索引
   - 检查类名是否正确（v1.0.1 起，输入 simpleName 也可尝试匹配；存在多个同名类时会列出所有全限定候选）
   - 确保项目依赖已正确解析

4. **macOS / Linux 下 `javap` 调用失败**
   - 该问题在 v1.0.1 已修复（不再硬编码 `javap.exe`）
   - 请确认已正确设置 `JAVA_HOME`，或将 `javap` 加入 `PATH`

## 测试说明

### 构建项目

```bash
npm install
npm run build
```

### 测试工具使用

项目提供了独立的测试工具，可以直接测试MCP服务的各个功能，无需通过MCP客户端。

```bash
# 测试所有工具
node test-tools.js

# 测试特定工具
node test-tools.js --tool decompile_class --class com.alibaba.excel.EasyExcelFactory --project /path/to/project

# 不使用缓存
node test-tools.js --tool decompile_class --no-cache

# 指定CFR路径
node test-tools.js --tool decompile_class --cfr-path /path/to/cfr.jar
```

### 测试工具参数

- `-t, --tool <工具名>`: 指定要测试的工具 (scan|decompile|analyze|all)
- `-p, --project <路径>`: 项目路径
- `-c, --class <类名>`: 要分析的类名
- `--no-refresh`: 不强制刷新依赖索引
- `--no-cache`: 不使用反编译缓存
- `--cfr-path <路径>`: 指定CFR反编译工具的jar包路径
- `-h, --help`: 显示帮助信息

### 日志级别控制

通过 `NODE_ENV` 环境变量控制日志输出：

- `development`: 输出详细调试信息
- `production`: 只输出关键信息
