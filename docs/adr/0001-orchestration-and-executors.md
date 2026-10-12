---
status: accepted
date: 2026-10-12
---

# 统一 LangGraph 底座，业务图与阶段执行器分别维护

两个项目采用统一的 LangGraph 编排底座，各自实现业务图并独立管理状态、业务记录与配置；ForgeLoop 首版通过 Python Adapter 接入容器内 PI，自研 Agent Runtime 移入 RoadMap。这个选择将首版投入集中到研发流程与真实交付验证，避免同时承担执行循环、上下文管理和业务编排的建设；代价是需要验证外部执行器的事件、暂停、会话恢复和轨迹能力。

共同底座共享代码和 Interface，不共享业务图中的领域规则或运行数据。将来自研 Runtime 作为新增执行器接入，不要求改写已确定的审批、计数与版本规则。本决策取代讨论中“ForgeLoop 自有编排、不使用共同流程框架”及“首版完整自研 Runtime”的方向；仅确认设计，尚未完成兼容性或故障测试。


2026-10-12 快速启动范围调整：该分层方向继续有效；首版先直接使用 LangGraph 与一个 PI Adapter，公共包在真实重复后抽取。邮件、页面、发布与复杂恢复都后置，实施范围见[首版需求](../product-requirements.md)与[需求审查](../requirements-review.md)。
