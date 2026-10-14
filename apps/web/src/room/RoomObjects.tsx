import { useEffect, useState } from 'react';
import { Lightbulb, Leaf, Layers, Hourglass, X, ArrowRight } from 'lucide-react';
import type { Scene, InteractionInput } from '../../../../shared/room';
export function RoomObjects({
  scene,
  interact,
  ready,
}: {
  scene: Scene;
  interact: (input: InteractionInput) => void;
  ready: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const [showCard, setShowCard] = useState(true);
  useEffect(() => {
    setShowCard(true);
  }, [scene.card?.id]);
  useEffect(() => {
    if (scene.timer.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [scene.timer.status]);
  const seconds = Math.max(0, Math.ceil((scene.timer.endsAt - now) / 1000));
  const act = (action: Extract<InteractionInput, { kind: 'action' }>['action']) =>
    interact({ kind: 'action', action });
  return (
    <>
      <div
        className="room-illumination"
        aria-hidden="true"
        style={{
          opacity: scene.light.on ? scene.light.brightness / 220 : 0,
          background: scene.light.warm
            ? 'radial-gradient(ellipse at 15% 45%, #ffdca2, transparent 70%)'
            : 'radial-gradient(ellipse at 15% 45%, #ffffff, transparent 70%)',
        }}
      />
      <div className="room-window" aria-hidden="true">
        <i />
        <i />
        <i />
        <span>✦</span>
        <b>✧</b>
      </div>
      <div className="room-floor" aria-hidden="true" />
      <div className="room-object object-lamp">
        <button
          aria-label={scene.light.on ? '关闭台灯' : '打开台灯'}
          disabled={!ready}
          onClick={() =>
            act({
              name: 'set_light',
              on: !scene.light.on,
              brightness: scene.light.brightness,
              warm: scene.light.warm,
            })
          }
        >
          <svg viewBox="0 0 120 130" aria-hidden="true">
            <ellipse cx="62" cy="118" rx="37" ry="6" fill="#c9d9eb" />
            <path d="M60 57V110" stroke="#6f8bb0" strokeWidth="7" />
            <path d="M36 113Q60 104 84 113V119H36Z" fill="#718fb6" />
            <path
              d="M36 20H84L101 65Q60 78 19 65Z"
              fill={scene.light.on ? (scene.light.warm ? '#f3d29c' : '#c7def8') : '#8d9eb7'}
              stroke="#829cbd"
              strokeWidth="2"
            />
            <ellipse cx="60" cy="65" rx="40" ry="9" fill={scene.light.on ? '#fff0c8' : '#b0bfd0'} />
            <path d="M92 66V86" stroke="#8194ad" strokeWidth="2" />
            <circle cx="92" cy="88" r="3" fill="#8194ad" />
            {scene.light.on && (
              <ellipse
                className="lamp-glow"
                cx="60"
                cy="80"
                rx="43"
                ry="23"
                fill={scene.light.warm ? '#ffe5a8' : '#eef7ff'}
                opacity=".35"
              />
            )}
          </svg>
          <strong>
            <Lightbulb size={12} />
            台灯
          </strong>
          <small>
            {scene.light.on
              ? `${scene.light.brightness}% · ${scene.light.warm ? '暖光' : '自然光'}`
              : '关灯了'}
          </small>
        </button>
        <button
          className="object-mini"
          disabled={!ready}
          onClick={() =>
            act({
              name: 'set_light',
              on: true,
              brightness: scene.light.brightness === 35 ? 80 : 35,
              warm: !scene.light.warm,
            })
          }
        >
          换个灯光
        </button>
      </div>
      <div
        className="room-object object-plant"
        data-testid="plant"
        data-water-count={scene.plant.waterCount}
      >
        <button
          aria-label="给盆栽浇水"
          disabled={!ready}
          onClick={() => act({ name: 'water_plant' })}
        >
          <svg viewBox="0 0 120 135" aria-hidden="true">
            <ellipse cx="60" cy="124" rx="35" ry="5" fill="#c9d9eb" />
            <path d="M58 91Q62 52 58 21" stroke="#6a9e85" fill="none" strokeWidth="4" />
            <path d="M59 63Q17 60 26 27Q61 27 59 63" fill="#8dbfa0" />
            <path d="M60 47Q97 43 96 12Q61 8 60 47" fill="#71ae92" />
            <path d="M60 80Q98 79 103 52Q76 47 60 80" fill="#9cc8a8" />
            <path d="M29 87H91L83 123H38Z" fill="#d4a68d" />
            <rect x="24" y="83" width="72" height="12" rx="5" fill="#e5bca3" />
            {scene.plant.waterCount > 0 && (
              <g key={scene.plant.waterCount} className="water-drops" fill="#69a9e5">
                <path d="M29 50q-10 15 0 15q10 0 0-15" />
                <path d="M88 30q-8 13 0 13q8 0 0-13" />
              </g>
            )}
          </svg>
          <strong>
            <Leaf size={12} />
            小盆栽
          </strong>
          <small>
            {scene.plant.moisture < 65 ? '有点口渴' : '土壤湿润'} · {scene.plant.moisture}%
          </small>
        </button>
        <div className="moisture-meter">
          <i style={{ width: `${scene.plant.moisture}%` }} />
        </div>
      </div>
      <div className="room-object object-cards">
        <button
          aria-label="抽一张发现卡"
          disabled={!ready}
          onClick={() => act({ name: 'draw_discovery_card' })}
        >
          <svg viewBox="0 0 120 110" aria-hidden="true">
            <ellipse cx="60" cy="99" rx="48" ry="6" fill="#c9d9eb" />
            <rect
              x="27"
              y="19"
              width="54"
              height="74"
              rx="6"
              fill="#bdd1ed"
              transform="rotate(-14 55 56)"
            />
            <rect
              x="38"
              y="15"
              width="54"
              height="74"
              rx="6"
              fill="#fff"
              stroke="#9fb9de"
              strokeWidth="2"
              transform="rotate(8 65 53)"
            />
            <path d="M63 33l6 13 14 2-10 10 2 14-12-7-13 7 3-14-11-10 15-2z" fill="#a3c4ee" />
            <path d="M15 90H108V100H15Z" fill="#90aacc" />
          </svg>
          <strong>
            <Layers size={12} />
            发现卡
          </strong>
          <small>{scene.card ? '再抽一张新发现' : '藏着一个小问题'}</small>
        </button>
        {scene.card && !showCard && (
          <button className="object-mini" onClick={() => setShowCard(true)}>
            查看当前卡片
          </button>
        )}
      </div>
      <div className="room-object object-timer">
        <button
          aria-label={scene.timer.status === 'running' ? '取消倒计时' : '休息一分钟'}
          disabled={!ready}
          onClick={() =>
            act(
              scene.timer.status === 'running'
                ? { name: 'cancel_timer' }
                : { name: 'start_timer', seconds: 60 },
            )
          }
        >
          <svg viewBox="0 0 100 125" aria-hidden="true">
            <ellipse cx="50" cy="114" rx="31" ry="5" fill="#c9d9eb" />
            <path
              d="M27 20C25 48 42 53 48 62C38 71 26 80 27 106H73C75 81 63 72 52 62C64 53 76 44 73 20Z"
              fill="#ffffffb0"
              stroke="#acc8dc"
              strokeWidth="2"
            />
            <path d="M33 35H67Q65 48 50 59Q35 48 33 35" fill="#e7c88f" />
            <path d="M32 102Q37 80 50 76Q66 84 68 102" fill="#e7c88f" />
            <path d="M50 62V83" stroke="#e7c88f" strokeWidth="2" />
            <rect x="19" y="13" width="62" height="9" rx="4" fill="#a3b5d0" />
            <rect x="19" y="104" width="62" height="9" rx="4" fill="#a3b5d0" />
          </svg>
          <strong>
            <Hourglass size={12} />
            休息沙漏
          </strong>
          <small>
            {scene.timer.status === 'running'
              ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · 点击取消`
              : scene.timer.status === 'completed'
                ? '休息结束了'
                : '给自己一分钟'}
          </small>
        </button>
        <button
          className="object-mini"
          disabled={!ready || scene.timer.status === 'running'}
          onClick={() => act({ name: 'start_timer', seconds: 10 })}
        >
          试试 10 秒
        </button>
      </div>
      {scene.card && showCard && (
        <aside className="discovery-card" aria-label="当前发现卡">
          <div className="discovery-title">
            <span>
              <Layers size={14} />
              今日的小发现
            </span>
            <button aria-label="收起发现卡" onClick={() => setShowCard(false)}>
              <X size={14} />
            </button>
          </div>
          <p>{scene.card.question}</p>
          {scene.card.revealed ? (
            <>
              <div className="card-answer">{scene.card.explanation}</div>
              <button className="card-next" onClick={() => act({ name: 'draw_discovery_card' })}>
                再来一张 <ArrowRight size={13} />
              </button>
            </>
          ) : (
            <div className="card-options">
              {scene.card.options.map((option, answerIndex) => (
                <button
                  key={option}
                  onClick={() => act({ name: 'answer_card', cardId: scene.card!.id, answerIndex })}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
        </aside>
      )}
    </>
  );
}
