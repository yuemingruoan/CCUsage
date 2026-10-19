# 服务端部署指南（通用模板）

> 本文是通用部署说明，不包含任何真实主机、账号或密码。请按自己的环境替换
> `<server>`、`<ssh-port>`、`<account>`、`<path>` 等占位符。

## 目标环境

| 项 | 建议 |
|---|---|
| 操作系统 | Linux（systemd 发行版，如 Debian/Ubuntu） |
| Node.js | >= 22.5（服务端使用内置 node:sqlite） |
| 部署目录 | `<path>/ccusage-server`（示例 `/opt/ccusage-server`） |
| 监听端口 | `<port>`（示例 8787） |
| 数据文件 | `<path>/ccusage-server/data/ccusage.sqlite` |

## 1. 构建并上传

```sh
npm run dist:server
scp -P <ssh-port> dist/server/* <user>@<server>:<path>/ccusage-server/
```

## 2. 初始化账号（命令行引导）

```sh
cd <path>/ccusage-server
./start.sh init              # Windows: start.cmd init
```

按提示输入用户名与两次密码（密码不回显）。也可非交互：

```sh
node ccusage-server.cjs init --username <account> --password '<password>'
node ccusage-server.cjs init --username <account> --password '<new-password>' --reset
```

## 3. systemd 服务

```ini
[Unit]
Description=CCUsage multi-device usage sync server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=<path>/ccusage-server
Environment=HOST=0.0.0.0
Environment=PORT=<port>
Environment=CCUSAGE_DB=<path>/ccusage-server/data/ccusage.sqlite
ExecStart=/usr/bin/node <path>/ccusage-server/ccusage-server.cjs serve
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload
systemctl enable --now ccusage-server
systemctl status ccusage-server
```

## 4. 验证

```sh
curl -s http://127.0.0.1:<port>/health                 # {"ok":true}
curl -s -X POST http://127.0.0.1:<port>/api/v1/login \
  -H 'content-type: application/json' \
  -d '{"username":"<account>","password":"<password>","device":{"name":"test","platform":"linux","appVersion":"2.1.0"}}'
```

外网访问还需要在云安全组/防火墙放行 `<port>`。

## 5. 桌面 app 连接

app → 设置 → 服务端：服务器 URL 填 `http://<server>:<port>`，使用 init 创建的账号登录；
多台设备同一账号即可在服务端汇总用量。

## 6. 更新服务端

```sh
npm run dist:server
scp -P <ssh-port> dist/server/* <user>@<server>:<path>/ccusage-server/
ssh -p <ssh-port> <user>@<server> 'systemctl restart ccusage-server'
```

## 7. 运维命令

```sh
systemctl status ccusage-server
systemctl restart ccusage-server
journalctl -u ccusage-server -n 100 --no-pager
node <path>/ccusage-server/ccusage-server.cjs accounts --db <path>/ccusage-server/data/ccusage.sqlite
```

## 安全建议

- 服务端为 HTTP 明文，公网部署建议置于 nginx/caddy 反向代理并启用 HTTPS；
- 使用专用系统用户运行服务、收紧数据目录权限；
- 使用强密码，并可通过 `init --reset` 定期更换；
- 不要把真实服务器信息、账号密码等提交到仓库。
