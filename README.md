# EasyConnect Workbench

桌面聚合工作台骨架，当前先把 EasyConnect 这一段收进 Electron。

## 当前能力

- 本地读取 EasyConnect 运行状态
- 保存 VPN 账号和调试端口
- 保存 EasyConnect 客户端路径
- 保存 VPN 网关列表
- 脱离终端拉起官方 EasyConnect 客户端
- 走官方 `connect.html -> portal -> password vm.login()` 恢复并登录
- 打开日志目录、配置目录

## 运行

```bash
cd easyconnect-workbench
npm install
npm start
```

## 说明

- 当前构建站、发版站只先保留配置区和后续适配入口。
- VPN 密码当前是本地明文 JSON 持久化，后续再补加密存储。
- 当前实现依赖本机已安装 EasyConnect；客户端路径已做成可配置，不再强依赖默认 `/Applications/EasyConnect.app/...`。
- 网关地址已按列表持久化，后续构建站/发版站和 VPN 直连恢复策略都会复用它。
- 现阶段依赖旁边的 `easyconnect-runtime-poc` 作为运行时能力来源，等流程稳定后可以再内聚进同一项目。
