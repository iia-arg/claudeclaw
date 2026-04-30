#!/usr/bin/env python3
"""
Exchange MCP Server — инструменты для работы с Exchange On-Premise
Протокол: JSON-RPC stdio (MCP)
"""
import json, sys, os
from exchangelib import Credentials, Account, Configuration, DELEGATE, Build, Version, Message, Mailbox, HTMLBody, CalendarItem, EWSDateTime, EWSTimeZone
from exchangelib.protocol import BaseProtocol, NoVerifyHTTPAdapter
import urllib3
urllib3.disable_warnings()
BaseProtocol.HTTP_ADAPTER_CLS = NoVerifyHTTPAdapter

SERVER   = os.environ.get("EXCHANGE_SERVER", "")
USERNAME = os.environ.get("EXCHANGE_USERNAME", "")
PASSWORD = os.environ.get("EXCHANGE_PASSWORD", "")
EMAIL    = os.environ.get("EXCHANGE_EMAIL", "")

_account = None

def get_account():
    global _account
    if _account is None:
        creds = Credentials(username=USERNAME, password=PASSWORD)
        config = Configuration(server=SERVER, credentials=creds,
                               version=Version(Build(15, 2)), auth_type="NTLM")
        _account = Account(primary_smtp_address=EMAIL, config=config,
                           autodiscover=False, access_type=DELEGATE)
    return _account

TOOLS = [
    {"name": "exchange_list_emails",
     "description": "Список последних писем из inbox Exchange",
     "inputSchema": {"type": "object", "properties": {
         "count": {"type": "integer", "description": "Кол-во писем (по умолч. 10)"}
     }}},
    {"name": "exchange_read_email",
     "description": "Прочитать письмо по ID",
     "inputSchema": {"type": "object", "required": ["id"], "properties": {
         "id": {"type": "string"}
     }}},
    {"name": "exchange_send_email",
     "description": "Отправить письмо",
     "inputSchema": {"type": "object", "required": ["to", "subject", "body"], "properties": {
         "to": {"type": "string"},
         "subject": {"type": "string"},
         "body": {"type": "string"}
     }}},
    {"name": "exchange_search_emails",
     "description": "Поиск писем по теме или отправителю",
     "inputSchema": {"type": "object", "required": ["query"], "properties": {
         "query": {"type": "string"}
     }}},
    {"name": "exchange_list_calendar",
     "description": "Список событий календаря",
     "inputSchema": {"type": "object", "properties": {
         "days": {"type": "integer", "description": "Дней вперёд (по умолч. 7)"}
     }}},
    {"name": "exchange_create_calendar_event",
     "description": "Создать событие в календаре",
     "inputSchema": {"type": "object", "required": ["subject", "start", "end"], "properties": {
         "subject": {"type": "string", "description": "Название события"},
         "start": {"type": "string", "description": "Начало: YYYY-MM-DD HH:MM"},
         "end": {"type": "string", "description": "Конец: YYYY-MM-DD HH:MM"},
         "location": {"type": "string", "description": "Место (опционально)"},
         "body": {"type": "string", "description": "Описание (опционально)"}
     }}},
    {"name": "exchange_delete_calendar_event",
     "description": "Удалить событие из календаря по subject и дате",
     "inputSchema": {"type": "object", "required": ["subject", "date"], "properties": {
         "subject": {"type": "string", "description": "Название события (частичное совпадение)"},
         "date": {"type": "string", "description": "Дата события: YYYY-MM-DD"}
     }}},
]

def handle_tool(name, args):
    acc = get_account()
    if name == "exchange_list_emails":
        count = args.get("count", 10)
        items = []
        for msg in acc.inbox.all().order_by("-datetime_received")[:count]:
            items.append({"id": str(msg.id), "subject": msg.subject,
                          "from": str(msg.sender), "date": str(msg.datetime_received),
                          "is_read": msg.is_read})
        return json.dumps(items, ensure_ascii=False)
    elif name == "exchange_read_email":
        from exchangelib import Q
        msg = acc.inbox.get(id=args["id"])
        return json.dumps({"subject": msg.subject, "from": str(msg.sender),
                           "date": str(msg.datetime_received),
                           "body": msg.text_body or str(msg.body)[:2000]}, ensure_ascii=False)
    elif name == "exchange_send_email":
        m = Message(account=acc, subject=args["subject"],
                    body=HTMLBody(args["body"]),
                    to_recipients=[Mailbox(email_address=args["to"])])
        m.send()
        return "Письмо отправлено"
    elif name == "exchange_search_emails":
        from exchangelib import Q
        results = []
        for msg in acc.inbox.filter(subject__icontains=args["query"]).order_by("-datetime_received")[:10]:
            results.append({"id": str(msg.id), "subject": msg.subject, "from": str(msg.sender)})
        return json.dumps(results, ensure_ascii=False)
    elif name == "exchange_list_calendar":
        import datetime
        tz = EWSTimeZone('Europe/Moscow')
        days = args.get("days", 7)
        now = datetime.datetime.now()
        start = EWSDateTime(now.year, now.month, now.day, now.hour, now.minute, tzinfo=tz)
        end = start + datetime.timedelta(days=days)
        events = []
        for ev in acc.calendar.view(start=start, end=end):
            events.append({"subject": ev.subject, "start": str(ev.start),
                           "end": str(ev.end), "location": str(ev.location or "")})
        return json.dumps(events, ensure_ascii=False)
    elif name == "exchange_create_calendar_event":
        import datetime
        tz = EWSTimeZone('Europe/Moscow')
        start_dt = datetime.datetime.strptime(args["start"], "%Y-%m-%d %H:%M")
        end_dt = datetime.datetime.strptime(args["end"], "%Y-%m-%d %H:%M")
        event = CalendarItem(
            account=acc,
            folder=acc.calendar,
            subject=args["subject"],
            start=EWSDateTime(start_dt.year, start_dt.month, start_dt.day, start_dt.hour, start_dt.minute, tzinfo=tz),
            end=EWSDateTime(end_dt.year, end_dt.month, end_dt.day, end_dt.hour, end_dt.minute, tzinfo=tz),
            location=args.get("location"),
            body=args.get("body")
        )
        event.save()
        return f"Событие '{args['subject']}' создано: {args['start']} - {args['end']}"
    elif name == "exchange_delete_calendar_event":
        import datetime
        tz = EWSTimeZone('Europe/Moscow')
        date = datetime.datetime.strptime(args["date"], "%Y-%m-%d")
        start = EWSDateTime(date.year, date.month, date.day, 0, 0, tzinfo=tz)
        end = start + datetime.timedelta(days=1)
        deleted = 0
        for ev in acc.calendar.view(start=start, end=end):
            if args["subject"].lower() in ev.subject.lower():
                ev.delete()
                deleted += 1
        if deleted:
            return f"Удалено событий: {deleted}"
        return f"Событие с '{args['subject']}' на {args['date']} не найдено"
    return "Unknown tool"

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            method = req.get("method")
            rid = req.get("id")
            params = req.get("params", {})

            if method == "initialize":
                resp = {"jsonrpc": "2.0", "id": rid, "result": {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {"name": "exchange-mcp", "version": "1.0"},
                    "capabilities": {"tools": {}}
                }}
            elif method == "tools/list":
                resp = {"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}}
            elif method == "tools/call":
                tool_name = params.get("name")
                tool_args = params.get("arguments", {})
                try:
                    result = handle_tool(tool_name, tool_args)
                    resp = {"jsonrpc": "2.0", "id": rid, "result": {
                        "content": [{"type": "text", "text": result}]
                    }}
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
