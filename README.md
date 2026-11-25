# 面试便利安排的分组采录与占位复核

这里的资料由本地来源模拟器提供，编号、参与方和历史业务记录全部为合成数据。运行环境为 Node.js 22.23.4，监听地址默认为 `127.0.0.1:8700`，可用 `PORT` 调整端口。

```sh
npm ci
npx playwright install chromium
npm run source
```

另开终端运行 `npm test` 可检查来源契约。测试以独立临时端口启动来源；浏览器资料由实际启动的 Chromium 读取。

两版业务记录和取件字段见 [资料格式](source/formats.md)。`POST /control?edition=r2` 模拟业务方更换当期资料，切回 `r1` 可重新查看初始来源。

本地演练还提供单独的外部接口。用 `npm run provider` 启动，默认地址为 `http://127.0.0.1:8701`，可用 `PROVIDER_PORT` 调整。来源语义、操作回执和演练档见[外部接口](source/provider.md)。

## 联络员采录与代办

新增能力位于 `assistant/`：

- `browser.mjs`：用 Playwright/Chromium 打开 `/desk`，逐视图、逐分页采录，并按“暂存安排 → 核对通知 → 发确认”操作门户。
- `core.mjs`：纯领域核对。只有 `merge` 视图/正式合并记录能合并报名号；许可严格匹配“报名号 + 轮次 + 服务内容”；占用区间包含准备时间，采用半开区间。
- `services.mjs`：读取设备房确认、实际送达回执，并用原报名号/原回执发起改期。
- `workflow.mjs` / `store.mjs`：重复同步、执行前新鲜复核、审计和 `.oral-access/workbench.json` 留档。
- `server.mjs`：本机工作台，默认 `http://127.0.0.1:8710/liaison`；面谈官白名单视图为 `/interviewer?as=I1`，JSON 为 `/api/interviewer?as=I1`。

常用命令：

```sh
# 采录并输出“可办理 / 暂留 / 已通知 / 需人工改约”及证据
npm run assistant -- sync --round r1

# 切换到正式合并 + 设备冲突演练档
curl -X POST 'http://127.0.0.1:8701/lab?stage=merged'
curl -X POST 'http://127.0.0.1:8700/control?edition=r2'

# 只查看自动动作；确认后可去掉 --dry-run，或改用 --apply 实际执行
npm run assistant -- sync --round r1 --dry-run
npm run assistant -- sync --round r1 --apply

# 切换到改约回读档后，N1 会显示 superseded/by N4，N4/S5 为 delivered
curl -X POST 'http://127.0.0.1:8701/lab?stage=informed'
npm run assistant -- sync --round r1
npm run assistant -- trail N1

# 面谈官视图：只有自己场次、时间、准备方式和准备分钟
npm run assistant -- interviewer --as I1 --round r1 --json

# 本机网页工作台
npm run workbench
```

复用 API：

```js
import { syncWorkbench, applyAutomaticActions, buildInterviewerView } from './index.mjs'

const { world } = await syncWorkbench({
  sourceUrl: 'http://127.0.0.1:8700',
  providerUrl: 'http://127.0.0.1:8701',
  statePath: '.oral-access/workbench.json',
  round: 'r1'
})

const interviewer = buildInterviewerView(world.items, 'I1')
await applyAutomaticActions({ sourceUrl: 'http://127.0.0.1:8700', providerUrl: 'http://127.0.0.1:8701' })
```

处理边界：

- 不用人员代号猜测同一人；外部记录和人工案始终保留 `B1`、`B2` 等原编号。
- `draft`、门户 `RC-*`、外部 `queued`、改期 HTTP 202 都不算送达；只有回执状态 `delivered` 才进入“已通知”。
- 已实际送达的安排受保护，不提供撤旧通知动作。只有原时段因设备/封闭/他岗占用而不可用时，才用原回执发起改期；仅因合并产生的冲突会退回未发编号并保留人工案。
- 自动门户代办前会重新采录；资格不符、准备+面谈不完整、人员或设备房区间冲突、窗口刚关闭时一律跳过。
- 面谈官 DTO 是白名单字段，不含报名号、其他岗位、许可、人员代号或合并依据。
