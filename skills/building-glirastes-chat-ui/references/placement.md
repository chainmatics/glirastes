
### Stops, names and inherited presentation

`pipelineBudgetStopLabel` localizes the persistent stop notice (`{count}`, `{max}`); `uiActionStatusLabels` localizes local browser outcomes (`succeeded`, `rejected`, `missing-handler`, `exception`, `timeout`, `cancelled`). These notices remain visible independently of result cards. Do not automatically replay mutations after a safety stop. Ask for the remaining work, preserving conversation history and reconciling uncertain outcomes.

`createLocalSessionStore` inherits the provider's `newChatLabel` through optional `SessionConfig.setDefaultTitle`; explicit `newTitle` and user-renamed conversations keep precedence. `AssistantShellButtonProps.style` carries inherited theme variables and should be forwarded by custom buttons. Registering tool renderers implicitly limits result cards to their registered tool names; explicitly select `toolResults.mode: 'default'` to show all raw results.

Use `createApprovalDescriptionGenerator` `fieldLabels` and `valueTranslations` for domain labels such as notes or scheduled. Short IDs require explicit `ApprovalDescriptionConfig.entityNames` maps keyed by full argument path (for example `technicianId` or `job.id`), using authorized records only. Global UUID names may resolve from finished results. Labels alone never establish record identity; signed arguments remain unchanged. See `docs/chat-dx-migration.md` for continuation and migration boundaries.
