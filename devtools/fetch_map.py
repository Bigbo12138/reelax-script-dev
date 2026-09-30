#!/usr/bin/env python3
"""通过 Firefox RDP 在页面上下文下载 source map，流式写盘。"""
import argparse, base64, json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rdp_query as rq

def main():
    p = argparse.ArgumentParser()
    p.add_argument("url")
    p.add_argument("outfile")
    p.add_argument("--port", type=int, default=None)
    p.add_argument("--chunk", type=int, default=30000)
    p.add_argument("--tab", type=int, default=0)
    args = p.parse_args()

    port, _ = rq.resolve_port(args.port)
    rdp = rq.RDP(rq.DEFAULT_HOST, port)
    rdp.greeting()
    tabs = rdp.request("root", "listTabs").get("tabs", [])
    if not tabs:
        print("no tabs"); sys.exit(1)
    actor = rq.get_console_actor(rdp, tabs[args.tab])
    if not actor:
        print("no console actor"); sys.exit(1)

    # 注入一个 worker 函数定义（同步），随后触发执行
    worker = r"""
    window.__mapFetch = async function(url, chunk){
      const r = await fetch(url);
      if(!r.ok) throw new Error('HTTP '+r.status);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const CH='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      let b64='';
      for(let i=0;i<bytes.length;i+=3){
        const n=(bytes[i]<<16)|((i+1<bytes.length?bytes[i+1]:0)<<8)|(i+2<bytes.length?bytes[i+2]:0);
        b64+=CH[(n>>18)&63]+CH[(n>>12)&63]+(i+1<bytes.length?CH[(n>>6)&63]:'=')+(i+2<bytes.length?CH[n&63]:'=');
      }
      const cs = Math.floor(chunk/4)*4;
      window.__mapChunks=[];
      for(let i=0;i<b64.length;i+=cs) window.__mapChunks.push(b64.slice(i,i+cs));
      return {size:bytes.length, chunks:window.__mapChunks.length};
    };
    """
    ack = rdp.request(actor, "evaluateJSAsync", {"text": worker})
    rid = ack.get("resultID")
    rdp.read_until(lambda p: p.get("type")=="evaluationResult" and p.get("resultID")==rid)

    # 触发异步执行
    wrapped = (
        "(async()=>{try{ window.__mapRes = await window.__mapFetch("
        + json.dumps(args.url) + "," + str(args.chunk) + "); }"
        "catch(__e){ window.__mapRes={__error:String(__e)}; }"
        "finally{ window.__mapDone=true; }})(); 'kicked';"
    )
    ack = rdp.request(actor, "evaluateJSAsync", {"text": wrapped})
    rid = ack.get("resultID")
    if rid is None:
        print("no resultID"); sys.exit(1)
    rdp.read_until(lambda p: p.get("type")=="evaluationResult" and p.get("resultID")==rid)

    # 轮询完成
    deadline = time.time()+180
    while time.time()<deadline:
        ack = rdp.request(actor, "evaluateJSAsync", {"text":"window.__mapDone===true"})
        rid = ack.get("resultID")
        pkt = rdp.read_until(lambda p: p.get("type")=="evaluationResult" and p.get("resultID")==rid)
        if rq.grip_to_python(pkt.get("result")) is True:
            break
        time.sleep(0.5)
    else:
        print("TIMEOUT waiting for fetch"); sys.exit(1)

    ack = rdp.request(actor, "evaluateJSAsync", {"text":"window.__mapRes"})
    rid = ack.get("resultID")
    pkt = rdp.read_until(lambda p: p.get("type")=="evaluationResult" and p.get("resultID")==rid)
    res = rq.grip_to_python(pkt.get("result"))
    if isinstance(res, dict) and "__error" in res:
        print("ERROR:", res["__error"]); sys.exit(1)
    n = res.get("chunks") if isinstance(res, dict) else 0
    print("fetched size/chunks:", res)

    def read_string_grip(grip):
        """处理普通字符串与 longString，返回完整 str。"""
        if grip is None:
            return ""
        if not isinstance(grip, dict):
            return str(grip)
        t = grip.get("type")
        if t == "string":
            return grip.get("value") or ""
        if t == "longString":
            actor_id = grip.get("actor")
            length = grip.get("length", 0)
            parts = []
            step = 50000
            for start in range(0, length, step):
                resp = rdp.request(actor_id, "substring", {"start": start, "end": min(start+step, length)})
                parts.append(resp.get("substring") or "")
            return "".join(parts)
        # 兜底
        if "value" in grip:
            return str(grip.get("value"))
        if "displayString" in grip:
            return str(grip.get("displayString"))
        return ""

    with open(args.outfile, "wb") as f:
        for i in range(n):
            ack = rdp.request(actor, "evaluateJSAsync", {"text":f"window.__mapChunks[{i}]"})
            rid = ack.get("resultID")
            pkt = rdp.read_until(lambda p: p.get("type")=="evaluationResult" and p.get("resultID")==rid)
            s = read_string_grip(pkt.get("result"))
            f.write(base64.b64decode(s))
            if i%5==0:
                print(f"  chunk {i}/{n}", flush=True)
    print("done:", args.outfile)
    rdp.s.close()

if __name__=="__main__":
    main()
