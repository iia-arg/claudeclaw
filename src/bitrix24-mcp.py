#!/usr/bin/env python3
"""Bitrix24 MCP Server — REST API через webhook"""
import json, sys, os
import urllib.request, urllib.parse

WEBHOOK = os.environ.get("BITRIX24_WEBHOOK", "")

def b24(method, params=None):
    url = f"{WEBHOOK}{method}"
    data = json.dumps(params or {}).encode()
    req = urllib.request.Request(url, data=data,
          headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

TOOLS = [
    {"name": "b24_crm_list_leads", "description": "Список лидов из CRM Битрикс24",
     "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}}}},
    {"name": "b24_crm_list_deals", "description": "Список сделок из CRM",
     "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}, "stage": {"type": "string"}}}},
    {"name": "b24_crm_get_deal", "description": "Получить сделку по ID",
     "inputSchema": {"type": "object", "required": ["id"], "properties": {"id": {"type": "integer"}}}},
    {"name": "b24_crm_create_lead", "description": "Создать новый лид",
     "inputSchema": {"type": "object", "required": ["title"], "properties": {
         "title": {"type": "string"}, "name": {"type": "string"},
         "phone": {"type": "string"}, "email": {"type": "string"}, "comment": {"type": "string"}}}},
    {"name": "b24_task_list", "description": "Список задач",
     "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}, "responsible_id": {"type": "integer"}}}},
    {"name": "b24_task_create", "description": "Создать задачу",
     "inputSchema": {"type": "object", "required": ["title"], "properties": {
         "title": {"type": "string"}, "description": {"type": "string"},
         "deadline": {"type": "string"}, "responsible_id": {"type": "integer"}}}},
    {"name": "b24_task_update", "description": "Обновить задачу (статус, описание)",
     "inputSchema": {"type": "object", "required": ["id"], "properties": {
         "id": {"type": "integer"}, "status": {"type": "integer"}, "title": {"type": "string"}}}},
    {"name": "b24_im_send", "description": "Отправить сообщение в чат Битрикс",
     "inputSchema": {"type": "object", "required": ["user_id", "message"], "properties": {
         "user_id": {"type": "integer"}, "message": {"type": "string"}}}},
    {"name": "b24_user_list", "description": "Список пользователей Битрикс",
     "inputSchema": {"type": "object", "properties": {"search": {"type": "string"}}}},
    {"name": "b24_profile", "description": "Мой профиль в Битрикс",
     "inputSchema": {"type": "object", "properties": {}}},
]

def handle_tool(name, args):
    if name == "b24_crm_list_leads":
        r = b24("crm.lead.list", {"order": {"DATE_CREATE": "DESC"},
               "select": ["ID","TITLE","NAME","PHONE","EMAIL","STATUS_ID","DATE_CREATE"],
               "start": 0, "limit": args.get("limit", 20)})
        return json.dumps(r.get("result", []), ensure_ascii=False)
    elif name == "b24_crm_list_deals":
        filt = {}
        if args.get("stage"): filt["STAGE_ID"] = args["stage"]
        r = b24("crm.deal.list", {"order": {"DATE_CREATE": "DESC"},
               "filter": filt,
               "select": ["ID","TITLE","STAGE_ID","ASSIGNED_BY_ID","DATE_CREATE","OPPORTUNITY","CURRENCY_ID"],
               "start": 0, "limit": args.get("limit", 20)})
        return json.dumps(r.get("result", []), ensure_ascii=False)
    elif name == "b24_crm_get_deal":
        r = b24("crm.deal.get", {"id": args["id"]})
        return json.dumps(r.get("result", {}), ensure_ascii=False)
    elif name == "b24_crm_create_lead":
        fields = {"TITLE": args["title"]}
        if args.get("name"): fields["NAME"] = args["name"]
        if args.get("phone"): fields["PHONE"] = [{"VALUE": args["phone"], "VALUE_TYPE": "WORK"}]
        if args.get("email"): fields["EMAIL"] = [{"VALUE": args["email"], "VALUE_TYPE": "WORK"}]
        if args.get("comment"): fields["COMMENTS"] = args["comment"]
        r = b24("crm.lead.add", {"fields": fields})
        return f"Лид создан, ID: {r.get('result')}"
    elif name == "b24_task_list":
        params = {"order": {"CREATED_DATE": "desc"},
                  "select": ["ID","TITLE","STATUS","DEADLINE","RESPONSIBLE_ID","CREATED_DATE"],
                  "filter": {}, "start": 0}
        if args.get("responsible_id"): params["filter"]["RESPONSIBLE_ID"] = args["responsible_id"]
        r = b24("tasks.task.list", params)
        return json.dumps(r.get("result", {}).get("tasks", []), ensure_ascii=False)
    elif name == "b24_task_create":
        fields = {"TITLE": args["title"], "CREATED_BY": 3273}
        if args.get("description"): fields["DESCRIPTION"] = args["description"]
        if args.get("deadline"): fields["DEADLINE"] = args["deadline"]
        if args.get("responsible_id"): fields["RESPONSIBLE_ID"] = args["responsible_id"]
        r = b24("tasks.task.add", {"fields": fields})
        return f"Задача создана, ID: {r.get('result', {}).get('task', {}).get('id')}"
    elif name == "b24_task_update":
        fields = {}
        if args.get("status"): fields["STATUS"] = args["status"]
        if args.get("title"): fields["TITLE"] = args["title"]
        r = b24("tasks.task.update", {"taskId": args["id"], "fields": fields})
        return json.dumps(r.get("result", {}), ensure_ascii=False)
    elif name == "b24_im_send":
        r = b24("im.message.add", {"DIALOG_ID": args["user_id"], "MESSAGE": args["message"]})
        return f"Сообщение отправлено, ID: {r.get('result')}"
    elif name == "b24_user_list":
        params = {"select": ["ID","NAME","LAST_NAME","EMAIL","WORK_POSITION","UF_PHONE_INNER"]}
        if args.get("search"): params["filter"] = {"FIND": args["search"]}
        r = b24("user.search" if args.get("search") else "user.get", params)
        return json.dumps(r.get("result", [])[:20], ensure_ascii=False)
    elif name == "b24_profile":
        r = b24("profile")
        return json.dumps(r.get("result", {}), ensure_ascii=False)
    return "Unknown tool"

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try:
            req = json.loads(line)
            method = req.get("method")
            rid = req.get("id")
            params = req.get("params", {})
            if method == "initialize":
                resp = {"jsonrpc": "2.0", "id": rid, "result": {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {"name": "bitrix24-mcp", "version": "1.0"},
                    "capabilities": {"tools": {}}}}
            elif method == "tools/list":
                resp = {"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}}
            elif method == "tools/call":
                try:
                    result = handle_tool(params.get("name"), params.get("arguments", {}))
                    resp = {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": result}]}}
                except Exception as e:
                    resp = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": str(e)}}
            elif method == "notifications/initialized":
                continue
            else:
                resp = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "Method not found"}}
            print(json.dumps(resp), flush=True)
        except Exception as e:
            print(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(e)}}), flush=True)

if __name__ == "__main__":
    main()
