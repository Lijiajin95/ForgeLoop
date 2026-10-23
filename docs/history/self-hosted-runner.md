# 自托管 runner 安装说明（P1 CD → 本机 Debian 部署）

用途：让 GitHub Actions 的**部署作业**在这台 Debian 上执行（`runs-on: [self-hosted, forgeloop-deploy]`）。
质量／安全／提交策略作业继续跑 GitHub 托管机，只有部署作业使用本机 runner。

状态：**尚未安装**。安装需要一次仓库管理员操作（获取注册 token）；安装后 S2 的 deploy 工作流才能落地。

## 安全边界（先读）

- runner 会在这台机器上**执行仓库工作流里的命令**，因此只以普通用户 `link` 运行，**不要用 root**，不要 `sudo ./svc.sh install`。
- 使用**专用标签** `forgeloop-deploy`，仓库里只有部署作业 `runs-on` 指向它；不要让其他作业（尤其未审阅的 PR 工作流）落到本机。
- 部署作业只做：下载 Release 资产 → 校验 `SHA256SUMS` → 调 `forgeloop deploy`。不引入其他权限。
- 不把生产凭据放进仓库 Secrets；本机部署不需要 token（公开仓库的 Release 资产可匿名下载）。

## 1. 下载 runner（最新版，实测 github.com 可达）

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
version="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))')"
echo "runner 版本: ${version}"
curl -fsSL -o runner.tar.gz \
  "https://github.com/actions/runner/releases/download/v${version}/actions-runner-linux-x64-${version}.tar.gz"
tar xzf runner.tar.gz
```

## 2. 注册（token 在网页获取，约 1 小时有效）

打开 <https://github.com/Lijiajin95/ForgeLoop/settings/actions/runners/new>，复制页面里的注册 token，然后：

```bash
cd ~/actions-runner
./config.sh \
  --url https://github.com/Lijiajin95/ForgeLoop \
  --token '<注册 token>' \
  --name debian-forgeloop \
  --labels forgeloop-deploy \
  --work _work \
  --unattended
```

## 3. 常驻（systemd user unit，不需要 sudo）

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/actions-runner.service <<'EOF'
[Unit]
Description=GitHub Actions self-hosted runner (ForgeLoop deploy)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/actions-runner
ExecStart=%h/actions-runner/run.sh
Restart=always
RestartSec=10
KillMode=process

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now actions-runner.service
systemctl --user status actions-runner.service --no-pager
```

让用户服务在未登录时也运行（这一步需要一次 sudo）：

```bash
sudo loginctl enable-linger link
```

## 4. 验证

```bash
journalctl --user -u actions-runner -n 30 --no-pager   # 应看到 "Listening for Jobs"
```

并在 <https://github.com/Lijiajin95/ForgeLoop/settings/actions/runners> 确认 runner 状态为 **Idle**。

## 5. 依赖与常见问题

- runner 依赖 `libicu`：Debian 13 一般已随系统提供；若 `./run.sh` 报缺库，按报错安装对应包（可能需要一次 `sudo apt-get install`）。
- 首次运行若报 `Must not run with sudo`，说明用 root 启动了，改用普通用户。
- 网络：本机走系统层代理（DNS 为 fake-ip 段），GitHub HTTPS 实测可达。

## 6. 卸载／重置

```bash
systemctl --user disable --now actions-runner.service
cd ~/actions-runner
./config.sh remove --token '<移除 token>'
```

移除 token 同样在 runner 设置页获取（Remove runner）。
