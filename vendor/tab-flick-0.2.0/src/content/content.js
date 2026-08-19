(()=>{function e(t,i="text/html"){let n=new DOMParser().parseFromString(t,i),o=t.match(/<\s*([a-zA-Z0-9-]+)/)[1];return document.adoptNode(n.querySelector(o))}let t={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};async function i(e){return chrome.runtime.sendMessage(e)}async function n(e){if(!e){let{id:t}=await chrome.windows.getCurrent();e=t.toString()}let t=await chrome.storage.session.get(e);return[e,t[e]]}async function o(e){let[,t]=await n(e);return t?.thumbnails??[]}async function a(e){return chrome.storage.session.set({isOverlayOpen:e})}let r="g7Kf9x",l=`${r}-fo`,s=`${r}-style`,c=chrome.runtime.getURL("images/favicon.png"),d={container:`${r}_container`,overlay:`${r}_overlay`,item:`${r}_item`,preview:`${r}_preview`,text:`${r}_text`,thumbnail:`${r}_thumbnail`,icon_thumbnail:`${r}_icon_thumbnail`,active:`${r}_active`,icon:`${r}_icon`,close_button:`${r}_close_button`,close_button_wrapper:`${r}_close_button_wrapper`},p={pink:{main:"#ff8ad4",thumbBg:"rgba(255, 138, 212, 0.3)",overlayBg:"#3d2236a1"},blue:{main:"#7aa2ff",thumbBg:"rgba(122, 162, 255, 0.3)",overlayBg:"#25314da1"},yellow:{main:"#ffd43b",thumbBg:"rgba(255, 212, 59, 0.3)",overlayBg:"#3a300da8"},green:{main:"#5ee17c",thumbBg:"rgba(94, 225, 124, 0.25)",overlayBg:"#1f3225a1"},red:{main:"#ff6b6b",thumbBg:"rgba(255, 107, 107, 0.3)",overlayBg:"#3a1b1ba8"},white:{main:"#d9d9d9",thumbBg:"rgba(217, 217, 217, 0.25)",overlayBg:"#222222a6"}},u=[],m=[],h=0,v=!1,f="Control",b=null,g={shortcut:"Ctrl+Q",color:"blue",layout:"overlays",tabCount:6};async function w(e){"OPEN_OVERLAY"===e.type?await x(e):"RELEASED"===e.type&&await y()}async function x(e){if(e.tabs?.length){if(f=e.modifierKey??"Control",g=e.prefs,v)h=(h+e.direction+m.length)%m.length,b&&Array.from($()?.children??[]).forEach((e,t)=>e.classList.toggle(d.active,t===h));else{let t=e.tabs.slice(0,g.tabCount),i=function(e,t){for(let i=0;i<e.length;i++)if(t(e[i],i,e))return i;return -1}(t,t=>t.id===e.tabId);h=e.fromCurrentTab&&1!==i?1:0,m=await I(t,e.windowId),await T(m)}$()?.focus()}}async function y(){v&&(j(),await V(h))}function $(){return b?.shadowRoot?.querySelector(`.${d.overlay}`)}async function _(e){e.key,e.key===f&&v&&(j(),await V(h))}function E(e){e.key===f||"Escape"===e.key&&v&&(j(),e.stopImmediatePropagation())}function B(e){v&&!e.target.closest(`.${d.overlay}`)&&j()}function L(){j()}function k(){document.hidden&&j()}function C(e){v&&e.preventDefault()}function A(e){let t=e.target,i=t.closest(`.${d.close_button}`);if(i)return void S(i);let n=t.closest(`.${d.item}`);if(n)return void function(e){let t=Number(e.dataset.index);if(0===t)return setTimeout(()=>j(),50);V(t)}(n)}async function S(e){let t=Number(e.dataset.tabid);try{await i({type:"TRY_CLOSE_TAB",id:t})}catch(e){console.warn("Tab close error:",e);return}m=m.filter(e=>e.id!==t),h=Math.min(h,m.length-1),await T(m)}async function T(i){var n;let{color:o}=g;if(document.fullscreenElement)try{await document.exitFullscreen()}catch(e){}b||(b=function(){let t=e(`
    <div class="${d.container}" style="position: fixed; top: 0; left: 0; z-index: 2147483647"/>
  `),i=e(`
    <style>
      .${d.overlay} {
        --gap: 20px;
        --color-main: currentColor;
        --color-thumbnail: currentColor;
        --color-overlay: currentColor;
        border: 1px solid #55555557;
        user-select: none;
        display: flex;
        background: var(--color-overlay);
        box-shadow: 3px 4px 16px 3px #0b0c1285;
        backdrop-filter: blur(10px);
        border-radius: 20px;
        padding: var(--gap) var(--gap) 8px var(--gap);
        gap: var(--gap);
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font: 12px sans-serif;
        color: white;
        flex-wrap: wrap;
        width: max-content;
        max-width: calc(100dvw - 2*var(--gap) - 2px);
        box-sizing: border-box;
        align-content: flex-start;
        justify-content: center;
        transition: opacity 150ms ease-out;
        outline: 0 solid transparent;
        opacity: 0;
        &.show {
          opacity: 1;
        }
        &.exportable {
          position: static;
          transform: none;
        }
      }

      .${d.item} {
        padding-bottom: 6px;
        border-radius: 6px;
        display: flex;
        flex-direction: column;
        flex: 0 0 140px;
        max-width: 140px;
        box-sizing: border-box;
        position: relative;
        transition: transform 200ms ease-out;
        
        &:hover {
          cursor: pointer;
          transform: scale(1.05);
          .${d.preview} {
            outline: 2px solid var(--color-main);
          }
          .${d.close_button_wrapper} {
            display: flex;
          }
        }
        &.${d.active}, &:hover.${d.active} {
          transform: scale(1.1);
          .${d.preview} {
            background: var(--color-thumbnail);
            outline: 2px solid var(--color-main);
            box-shadow: 2px 4px 10px #1f223570;
          }
        }
      } 
      .${d.preview} {
        background: rgba(255, 255, 255, 0.08);
        height: 90px;
        margin-bottom: 6px;
        border-radius: 8px;
        overflow: hidden;
        border: 2px solid transparent;
        transition: outline-color 200ms ease-out;
        outline: 0 solid transparent;
      }
      .${d.text} {
        font-size: 14px;
        font-family: system-ui;
        display: flex;
        gap: 4px;
        align-items: center;
        min-width: 0;
        filter: drop-shadow(1px 1px 4px rgba(34,34,34,0.52));
        span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
          flex: 1;
        }
      }
      .${d.thumbnail} {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: top center;
        display: block;
        overflow: visible;
      }
      .${d.icon_thumbnail} {
        width: 48px;
        position: relative;
        top: calc(50% - 24px);
        left: calc(50% - 24px);
        opacity: 0.3;
      }
      .${d.icon} {
        height: 14px;
        width: 14px;
        vertical-align: bottom;
      }
      .${d.close_button_wrapper} {
        display: none;
        align-items: center;
        justify-content: center;
        position: absolute;
        height: 24px;
        width: 24px;
        top: -10px;
        right: -10px;
      }
      .${d.close_button} {
        height: 20px;
        width: 20px;
        align-items: center;
        justify-content: center;
        padding: 0;
        border-radius: 50%;
        border: 0;
        background: #ff6b6b;
        display: flex;
        cursor: pointer;
        &:hover {
          background: #ff8282;
        }
      }
      
      @media (max-width: 600px) {
        .${d.overlay} {
          --gap: 0;
          padding: 8px;
          flex-direction: column;
          
          .${d.item} {
            flex: 1;
            max-width: 180px;
            
            .${d.text} {
              padding: 8px;
              border-radius: 8px;
            }
            
            &:hover, &.${d.active}, &:hover.${d.active} {
              transform: scale(1);
              .${d.text} {
                color: white;
                outline: 2px solid var(--color-main);
              }
            }
          }
          
          .${d.preview} {
            display: none;
          }
          
        }
     
      }
    </style>
  `),n=t.attachShadow({mode:"open"}),o=e(`
    <div class="${d.overlay} " tabindex="-1"></div>
  `),a=e(`
    <div tabindex="-1" style="padding: "  ></div>
  `);return a.appendChild(o),o.addEventListener("pointerdown",A),n.appendChild(i),n.appendChild(a),t}());let r=$(),u=(n=h,e(`
    <div>
      ${i.map((e,i)=>{var o;return`
        <div data-index="${i}" class="${d.item} ${i===n?d.active:""}">
          <div class="${d.preview}">
            ${(o=e).thumbnail?`<img class="${d.thumbnail}" src="${o.thumbnail}"  alt="thumb">`:"normal"!==o.type?`<img class="${d.icon_thumbnail}" src="${chrome.runtime.getURL(`images/${o.type}.svg`)}"  alt="thumb">`:""}
          </div>
          <span class="${d.text}">
            <img class="${d.icon}" src="${e.favIconUrl||c}" alt="favicon">
            <span>${e.title?e.title.replace(/[&<>"']/g,e=>t[e]):"(untitled)"}</span>
          </span>
          ${!e.isPinned?`
            <div class="${d.close_button_wrapper}">
              <button data-tabid="${e.id}" class="${d.close_button}"><svg height="18px" width="18px" viewBox="0 -960 960 960" fill="white"><path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/></svg></button>
            </div>
          `:""}          
        </div>
      `}).join("")}
    </div>
  `));r.style.setProperty("--color-main",p[o].main),r.style.setProperty("--color-thumbnail",p[o].thumbBg),r.style.setProperty("--color-overlay",p[o].overlayBg),r.replaceChildren(...Array.from(u.childNodes)),r.addEventListener("error",e=>{e.target instanceof HTMLImageElement&&(e.target.src=c)},!0),function(t){if(t){if(document.documentElement instanceof SVGSVGElement){let i=document.documentElement;i.dataset.originalViewBox=i.getAttribute("viewBox")??"",i.setAttribute("viewBox","");let n=e(`
    <style id="${s}" xmlns="http://www.w3.org/2000/svg">
      :root {
				width: 100vw !important;
				height: 100vh !important;
				display: block !important;
			}
			:root > :not(#${l}) { 
				visibility: hidden !important; 
			}
    </style>
  `);i.insertBefore(n,i.firstChild);let o=e(`
    <foreignObject 
      id="${l}" 
      xmlns="http://www.w3.org/2000/svg" 
      x="0" y="0" 
      width="100%" height="100%"
    >
    </foreignObject>
  `,"image/svg+xml");o.appendChild(t),i.appendChild(o)}else document.body.appendChild(t);requestAnimationFrame(()=>$()?.classList.add("show"))}}(b),a(v=!0)}async function V(e){if(m?.[e]?.id)return i({type:"ACTIVATE_TAB",id:m[e].id})}function j(){if(v){var e=b;if(e)if($()?.classList.remove("show"),document.documentElement instanceof SVGSVGElement){let t=document.documentElement;t.dataset.originalViewBox&&(t.setAttribute("viewBox",t.dataset.originalViewBox),delete t.dataset.originalViewBox),document.getElementById(s)?.remove(),e.parentElement?.remove(),e.remove()}else e.remove();a(v=!1)}}async function I(e,t){let i=await o(t);return e.map(e=>({...e,thumbnail:i.find(t=>t.tabId===e.id)?.thumbnail}))}(async function e(){console.log(`Tab Flick \u{2728} v${chrome.runtime.getManifest().version}`),chrome.runtime.onMessage.addListener(w),u.push(()=>chrome.runtime.onMessage.removeListener(w)),window.addEventListener("keyup",_,!0),u.push(()=>window.removeEventListener("keyup",_)),window.addEventListener("keydown",E,!0),u.push(()=>window.removeEventListener("keydown",E)),window.addEventListener("blur",L),u.push(()=>window.removeEventListener("blur",L)),document.addEventListener("visibilitychange",k),u.push(()=>document.removeEventListener("visibilitychange",k)),window.addEventListener("click",B),u.push(()=>window.removeEventListener("click",B)),document.addEventListener("contextmenu",C),u.push(()=>document.removeEventListener("contextmenu",C))})()})();