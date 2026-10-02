# Fieldbook 具身智能场景库 MVP

静态前端演示入口：`embodied-scene-mvp.html`。

## 演示账号

- 管理员：`linxiao@fieldbook.ai`
- 供应商：`ops@lingjing.example`
- 客户：`procurement@xinglan.example`
- 演示密码：`fieldbook2026`

## 生产部署建议

前端可部署至 Nginx、CDN 或静态站点托管。应用服务器负责身份认证、业务数据和上传签名；图片及视频存入对象存储，不能提交到 Git 仓库或保存在应用容器的本地磁盘。

详细环境与存储配置请见项目交付说明。
