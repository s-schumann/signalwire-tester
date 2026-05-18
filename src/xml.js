export function xmlEscape(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function signalWireVoiceXml(message) {
  return xmlResponse(`<Say>${xmlEscape(message)}</Say><Pause length="1"/><Hangup/>`);
}

export function placetelControlXml(placetelConfig, override = {}) {
  const action = (override.action || placetelConfig.action || "hangup").toLowerCase();

  switch (action) {
    case "forward": {
      const targets = override.forwardTargets || placetelConfig.forwardTargets;
      if (!targets.length) return xmlResponse("<Hangup />");
      const ringtime = override.forwardRingtime || placetelConfig.forwardRingtime;
      const numbers = targets
        .map((target) => `<Number>${xmlEscape(target)}</Number>`)
        .join("");
      return xmlResponse(
        `<Forward><Target ringtime="${xmlEscape(ringtime)}">${numbers}</Target></Forward>`,
      );
    }
    case "reject":
      return xmlResponse("<Reject />");
    case "busy":
      return xmlResponse('<Reject reason="busy" />');
    case "prompt": {
      const id = override.promptId || placetelConfig.promptId;
      return id ? xmlResponse(`<Prompt id="${xmlEscape(id)}" />`) : xmlResponse("<Hangup />");
    }
    case "group": {
      const id = override.groupId || placetelConfig.groupId;
      return id ? xmlResponse(`<Group id="${xmlEscape(id)}" />`) : xmlResponse("<Hangup />");
    }
    case "routing_plan": {
      const id = override.routingPlanId || placetelConfig.routingPlanId;
      return id
        ? xmlResponse(`<RoutingPlan id="${xmlEscape(id)}" />`)
        : xmlResponse("<Hangup />");
    }
    case "queue": {
      const id = override.queueId || placetelConfig.queueId;
      return id ? xmlResponse(`<Queue id="${xmlEscape(id)}" />`) : xmlResponse("<Hangup />");
    }
    case "hangup":
    default:
      return xmlResponse("<Hangup />");
  }
}

function xmlResponse(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}
