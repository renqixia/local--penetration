import React from 'react';
import {AbsoluteFill,Audio,Composition,Img,Sequence,interpolate,registerRoot,spring,staticFile,useCurrentFrame} from 'remotion';

/* Google Material 配色 */
const G=['#4285f4','#ea4335','#fbbc04','#34a853'];
const INK='#202124',MUTED='#5f6368',PAPER='#f8f9fa',LINE='#dadce0',BLUE='#1a73e8';

/* 缓动：Material emphasized 风格，全程单调无回跳 */
const ease=(f:number,start=0,d=24)=>{
  const t=Math.max(0,Math.min(1,(f-start)/d));
  return 1-Math.pow(1-t,3);
};
/* 所有动画位移取整，避免亚像素抖动 */
const r=(n:number)=>Math.round(n);

const text=['本地跑起来。','发出去，才算看见。','一个端口，就够了。','从这里，到那里。','先验证，再分享。','小屏幕，也看得清。','分享，由你掌控。','结束分享，很简单。','让想法更快被看见。','虚渡'];
const sub=['你的网页，值得被打开。','原型演示 · 远程预览 · 临时联调','启动本地服务，输入端口。','临时 HTTPS 链接，访客直接打开。','从本机检查公网首页。','让对方用自己的设备打开。','活动隧道与历史分开管理。','停止对应隧道，即可结束。','无需账号，开始就很轻。','本地网页 · 一键分享'];

const Card:React.FC<{children?:React.ReactNode,style?:React.CSSProperties}>=({children,style})=>
  <div style={{boxSizing:'border-box',background:'#fff',border:'1px solid '+LINE,borderRadius:28,boxShadow:'0 12px 32px rgba(60,64,67,.16)',padding:35,...style}}>{children}</div>;

/* 每章一个连续 90 帧镜头：进场 0-24f，停留 24-78f，整体在章末以统一向上滑出收尾，不跳切 */
function Scene({n}:{n:number}){
  const f=useCurrentFrame();
  const dark=n===8;
  const enter=ease(f,0,24);
  const exit=ease(f,80,10);
  const p=enter*(1-exit);           /* 组合进度：章末统一淡出上移 */
  const q=ease(f,25,24);
  const s=spring({frame:f,fps:30,config:{damping:200,stiffness:120}}); /* 高阻尼，无振荡 */
  const scene:React.CSSProperties={background:dark?INK:PAPER,color:dark?'#fff':INK,fontFamily:'"PingFang SC",sans-serif',overflow:'hidden'};
  return <AbsoluteFill style={scene}>
    <div style={{position:'absolute',left:72,top:42,fontSize:20,letterSpacing:2,opacity:r(p*70)/100}}>虚渡 / {n<3?'开始':n<7?'分享':'掌控'}</div>
    <div style={{position:'absolute',right:72,top:47,display:'flex',gap:8,opacity:p}}>{G.map(c=><div key={c} style={{width:10,height:10,background:c,borderRadius:'50%'}}/>)}</div>

    {n!==9&&<div style={{position:'absolute',left:76,top:107,transform:`translateY(${r((1-enter)*34-exit*40)}px)`,opacity:p}}>
      <div style={{fontSize:57,fontWeight:650,letterSpacing:-2}}>{text[n]}</div>
      <div style={{fontSize:23,color:dark?'#bdc1c6':MUTED,marginTop:15}}>{sub[n]}</div>
    </div>}

    <div style={{position:'absolute',inset:0,opacity:p,transform:`translateY(${r(exit*-30)}px)`}}>
      {n===0&&<div style={{position:'absolute',inset:0}}>
        {/* 四色圆点稳定绕椭圆旋转：位置取整、速度恒定，无加减速抖动 */}
        {G.map((c,i)=>{
          const a=i*Math.PI/2+f*Math.PI/75;
          return <div key={c} style={{position:'absolute',width:110,height:110,borderRadius:55,background:c,
            left:r(640+Math.cos(a)*210-55),top:r(430+Math.sin(a)*110-55),
            transform:`scale(${ease(f,i*4,20)})`}}/>;
        })}
      </div>}

      {n===1&&<div style={{position:'absolute',left:110,top:310,display:'flex',gap:25}}>
        {['原型','布局','接口'].map((x,i)=><Card key={x} style={{width:310,height:240,transform:`translateY(${r((1-ease(f,i*8,22))*330)}px)`}}>
          <div style={{width:58,height:58,borderRadius:18,background:G[i],marginBottom:25}}/>
          <strong style={{fontSize:36}}>{x}</strong>
          <div style={{height:8,width:'70%',background:'#e8eaed',marginTop:23,borderRadius:4}}/>
        </Card>)}
      </div>}

      {n===2&&<Card style={{position:'absolute',left:180,top:310,width:920,transform:`scale(${.92+.08*Math.min(s,1)})`}}>
        <div style={{fontSize:18,color:MUTED,marginBottom:25}}>本地网页端口</div>
        <div style={{display:'flex',alignItems:'center',gap:18}}>
          <div style={{fontSize:52,flex:1}}>localhost:<span style={{color:BLUE,fontWeight:700}}>{'3000'.slice(0,Math.max(0,Math.floor((f-15)/5)))}</span><span style={{color:BLUE,opacity:f%30<16?1:0}}>│</span></div>
          <div style={{background:f>47?'#188038':BLUE,padding:'20px 25px',borderRadius:30,color:'#fff',fontSize:24}}>建立分享</div>
        </div>
        <div style={{height:4,background:BLUE,width:r(q*920*0.82),marginTop:25,borderRadius:2}}/>
      </Card>}

      {n===3&&<>
        <svg style={{position:'absolute',top:300,left:0}} width="1280" height="280">
          <path d="M260 140 C520 -30 760 310 1020 140" fill="none" stroke={LINE} strokeWidth="4"/>
          <path d="M260 140 C520 -30 760 310 1020 140" fill="none" stroke={BLUE} strokeWidth="5" pathLength="1" strokeDasharray="1" strokeDashoffset={1-q}/>
        </svg>
        {['你的 Mac','公网链接'].map((x,i)=><Card key={x} style={{position:'absolute',left:i?895:95,top:365,width:290,textAlign:'center',transform:`scale(${ease(f,i*12,20)})`}}>
          <div style={{fontSize:32}}>{x}</div>
          <div style={{fontSize:18,color:MUTED,marginTop:10}}>{i?'访客直接打开':'本地服务运行中'}</div>
        </Card>)}
      </>}

      {n===4&&<div style={{position:'absolute',left:140,top:300,display:'flex',gap:25}}>
        {['端口就绪','建立隧道','首页可达'].map((x,i)=>{
          const a=ease(f,10+i*13,18);
          return <Card key={x} style={{width:310,height:260,background:a>.5?'#e6f4ea':'#fff',opacity:.3+.7*a,transform:`translateY(${r((1-a)*60)}px)`,textAlign:'center'}}>
            <svg width="84" height="84" viewBox="0 0 24 24" style={{marginTop:8}}><circle cx="12" cy="12" r="11" fill={a>.5?'#188038':'#e8eaed'}/><path d="M7 12.5 L10.5 16 L17 9" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" opacity={a>.5?1:0}/></svg>
            <div style={{fontSize:28,marginTop:18}}>{x}</div>
          </Card>;
        })}
      </div>}

      {n===5&&<div style={{position:'absolute',left:150,top:280,display:'flex',alignItems:'center',gap:65}}>
        <Card style={{width:640,height:290,transform:`translateY(${r((1-enter)*40)}px)`}}>
          <div style={{display:'flex',gap:8}}>{G.map(c=><div key={c} style={{width:10,height:10,borderRadius:6,background:c}}/>)}</div>
          <div style={{fontSize:53,marginTop:50}}>同一个网页。</div>
          <div style={{height:15,width:'80%',background:'#e8eaed',marginTop:25,borderRadius:8}}/>
        </Card>
        <Card style={{width:200,height:330,border:'8px solid '+INK,padding:18,transform:`translateY(${r((1-q)*260)}px)`}}>
          <div style={{width:55,height:8,background:INK,borderRadius:9,margin:'0 auto'}}/>
          <div style={{fontSize:30,marginTop:60}}>另一种<br/>好看。</div>
          <div style={{height:8,background:'#e8eaed',marginTop:25,borderRadius:4}}/>
        </Card>
      </div>}

      {n===6&&<div style={{position:'absolute',left:315,top:245,width:650,borderRadius:26,overflow:'hidden',boxShadow:'0 24px 80px rgba(60,64,67,.25)',transform:`translateY(${r((1-enter)*70)}px)`}}>
        <Img src={staticFile('console.png')} style={{display:'block',width:'100%'}}/>
      </div>}

      {n===7&&<Card style={{position:'absolute',left:250,top:325,width:780}}>
        <div style={{fontSize:32,marginBottom:25}}>这次演示，到这里。</div>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <span style={{fontSize:23,color:MUTED}}>{f>38?'分享已结束':'临时链接正在运行'}</span>
          <div style={{background:f>38?'#e8eaed':INK,color:f>38?MUTED:'#fff',padding:'15px 28px',borderRadius:24,fontSize:23}}>停止分享</div>
        </div>
      </Card>}

      {n===8&&<div style={{position:'absolute',left:85,top:310,width:1110,display:'flex',gap:18}}>
        {['免注册','免登录','轻分享'].map((x,i)=><div key={x} style={{flex:1,fontSize:62,fontWeight:600,padding:'50px 24px',background:G[i],color:i===2?INK:'#fff',borderRadius:28,transform:`translateY(${r((1-ease(f,i*9,22))*200)}px)`}}>{x}</div>)}
      </div>}

      {n===9&&<div style={{position:'absolute',inset:0,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}>
        <div style={{display:'flex',gap:13,marginBottom:30}}>{G.map((c,i)=><div key={c} style={{width:22,height:22,borderRadius:15,background:c,transform:`translateY(${r((1-ease(f,i*3,18))*-100)}px)`}}/>)}</div>
        <div style={{fontSize:115,fontWeight:650,letterSpacing:10,transform:`scale(${.94+.06*enter})`,opacity:enter}}>虚渡</div>
        <div style={{fontSize:30,color:MUTED,marginTop:25,opacity:q}}>本地网页，一键分享。</div>
      </div>}
    </div>

    <div style={{position:'absolute',bottom:32,left:76,fontSize:16,color:dark?'#bdc1c6':'#80868b',opacity:p}}>临时 HTTP 分享 · 需保持本地服务运行</div>
  </AbsoluteFill>;
}

/* 10 章 × 90 帧连续镜头：镜头间无位移跳变，统一滑出收尾 */
const Promo=()=> <AbsoluteFill>
  <Audio src={staticFile("music.mp3")} volume={frame=>0.14*Math.min(1,frame/12,(900-frame)/60)}/>
  {Array.from({length:10},(_,n)=><Sequence key={n} from={n*90} durationInFrames={90}><Scene n={n}/></Sequence>)}
</AbsoluteFill>;
registerRoot(()=> <Composition id="VoidBridge" component={Promo} durationInFrames={900} fps={30} width={1280} height={720}/>);
