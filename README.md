# Agent Runtime Proxy · Agent 运行时拦截代理

[![npm version](https://img.shields.io/npm/v/agent-runtime-proxy.svg)](https://www.npmjs.com/package/agent-runtime-proxy)

> **在 MCP 服务器前面站一道独立的保安：不相信宿主里的任何插件，危险调用一律不放行。**

宿主内的插件有加载顺序问题——一个恶意或先注册的插件，可能赶在安全检查之前动手。`agent-runtime-proxy` 是一条**透明 stdio 代理**，包住目标 MCP server，在进程外、网络边界独立拦截：

```
MCP Client  ←stdio→  agent-runtime-proxy  ←stdio→  目标 MCP Server
                         （只拦 tools/call）
```

对客户端而言，它就是一个普通 MCP server；`initialize` / `tools/list` / `ping` 及所有 notification 双向透传，**只有 `tools/call` 被拦截并先做运行时验证**。

- ✅ **fail-closed**：判为危险、验证器出错/不可用、超时——都**不转发**，返回 MCP `isError` + 签名拒付收据
- ✅ **放行才转发**，结果在 `result._meta.ccs` 附带 Ed25519 双收据，不动 MCP content 协议
- ✅ **两模式**：`enforce`（默认真拦）/ `shadow`（全转发，仅标记观测到的拦截，用于灰度）
- ✅ **零依赖**，纯 Node.js 标准库（Node ≥ 18）

---

## ⚡ 使用

```bash
# 全局安装
npm install -g agent-runtime-proxy
```

把客户端的 MCP server 启动命令包在代理后面：

```bash
agent-runtime-proxy -- <原 MCP server 启动命令>
```

例如包住一个本地 server：

```json
{
  "mcpServers": {
    "my-tool-guarded": {
      "command": "agent-runtime-proxy",
      "args": ["--", "node", "/path/to/original-server.js"]
    }
  }
}
```

## 验证器从哪来

代理在拦截时需要一个运行时验证器，按以下顺序自动发现：

1. `--verifier-module` / `CCS_VERIFIER_MODULE` 指定的模块
2. `require("agent-runtime-guard")`（推荐，与本代理配套）
3. 旧包 `ccs-mcp-server` 兜底
4. 相邻项目 `ccs-mcp-server-m8ven-fix/src`（开发环境）

自定义模块需导出 `verifyCall(call, policy)`。找不到验证器时默认 fail-closed，不转发。

## 选项

| 选项 / 环境变量 | 作用 |
|---|---|
| `--mode enforce\|shadow` / `CCS_MODE` | 拦截模式，默认 enforce |
| `--caller-id <id>` / `CCS_CALLER_ID` | 合成的调用方身份 |
| `--verifier-module <path>` / `CCS_VERIFIER_MODULE` | 显式指定验证器模块 |
| `--timeout <ms>` / `CCS_VERIFY_TIMEOUT_MS` | 验证预算，超时 fail-closed |

## 边界（如实说明）

- **仅 stdio 传输**，SSE / streamable-HTTP 暂不支持
- 调用方身份是合成的（MCP 协议本身无可认证身份），Identity 维度要硬需上游提供已核验身份
- 签名密钥的固定/轮换/HSM 待部署方案落实；自动生成密钥仅限开发

## Links

- npm: https://www.npmjs.com/package/agent-runtime-proxy
- GitHub: https://github.com/DSHCorrectover/agent-runtime-proxy
- 配套验证器: https://www.npmjs.com/package/agent-runtime-guard

## License

Elastic License 2.0 (ELv2). See [LICENSE](LICENSE).
