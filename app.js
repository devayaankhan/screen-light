// Lumina Screen Light - Main Logic
(function() {
  'use strict';

  // Core Light Modes (White -> Yellow -> Red)
  const COLOR_CYCLE = [
    { color: '#ffffff', name: 'White Light (सफेद)', textColor: '#111111' },
    { color: '#ffe600', name: 'Warm Yellow (पीला)', textColor: '#111111' },
    { color: '#ff0033', name: 'Night Red (लाल)', textColor: '#ffffff' }
  ];

  let currentColorIndex = 0;
  let brightness = 100;
  let wakeLock = null;
  let isWakeLockEnabled = true;
  let isSoundEnabled = true;
  let strobeInterval = null;
  let strobeMode = 'off'; // 'off' | 'fast' | 'sos'
  let deferredPrompt = null;
  let lastTapTime = 0;
  let hudTimeout = null;
  let badgeTimeout = null;

  // DOM Elements
  const lightSurface = document.getElementById('light-surface');
  const dimLayer = document.getElementById('dim-layer');
  const colorBadge = document.getElementById('color-badge');
  const badgeDot = document.getElementById('badge-dot');
  const badgeText = document.getElementById('badge-text');
  const introToast = document.getElementById('intro-toast');
  const hudControls = document.getElementById('hud-controls');
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const iconFsEnter = document.getElementById('icon-fs-enter');
  const iconFsExit = document.getElementById('icon-fs-exit');
  const btnSettings = document.getElementById('btn-settings');
  const settingsModal = document.getElementById('settings-modal');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const brightnessSlider = document.getElementById('brightness-slider');
  const brightnessText = document.getElementById('brightness-text');
  const colorOptions = document.querySelectorAll('.color-option');
  const toggleWakelock = document.getElementById('toggle-wakelock');
  const wakelockStatus = document.getElementById('wakelock-status');
  const toggleSound = document.getElementById('toggle-sound');
  const btnInstall = document.getElementById('btn-install');
  const strobeOffBtn = document.getElementById('strobe-off');
  const strobeFastBtn = document.getElementById('strobe-fast');
  const strobeSosBtn = document.getElementById('strobe-sos');
  const themeMeta = document.querySelector('meta[name="theme-color"]');

  // Audio Synth for tactile clicks
  let audioCtx = null;
  function playClickSound() {
    if (!isSoundEnabled) return;
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(300, audioCtx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.04);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.04);
    } catch (e) {
      // Audio not permitted or supported yet
    }
  }

  function triggerHaptic() {
    if (isSoundEnabled && 'vibrate' in navigator) {
      try {
        navigator.vibrate(25);
      } catch (e) {}
    }
  }

  // Set Light Color
  function setLightColor(colorHex, name, customIndex = null) {
    lightSurface.style.backgroundColor = colorHex;
    document.body.style.backgroundColor = colorHex;
    if (themeMeta) {
      themeMeta.setAttribute('content', colorHex);
    }

    // Update active swatch
    colorOptions.forEach((btn) => {
      const btnColor = btn.getAttribute('data-color').toLowerCase();
      if (btnColor === colorHex.toLowerCase()) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    if (customIndex !== null) {
      currentColorIndex = customIndex;
    } else {
      const matchIdx = COLOR_CYCLE.findIndex(c => c.color.toLowerCase() === colorHex.toLowerCase());
      if (matchIdx !== -1) currentColorIndex = matchIdx;
    }

    // Stop strobe if running
    if (strobeMode !== 'off') {
      stopStrobe();
    }

    // Show Notification Pill
    showBadge(colorHex, name);
  }

  // Show color change notification pill
  function showBadge(colorHex, name) {
    badgeDot.style.backgroundColor = colorHex;
    badgeText.textContent = name;
    colorBadge.classList.remove('hide');
    colorBadge.classList.add('show');

    clearTimeout(badgeTimeout);
    badgeTimeout = setTimeout(() => {
      colorBadge.classList.remove('show');
      colorBadge.classList.add('hide');
    }, 1200);
  }

  // Cycle Next Color (White -> Yellow -> Red -> White)
  function cycleColor() {
    currentColorIndex = (currentColorIndex + 1) % COLOR_CYCLE.length;
    const next = COLOR_CYCLE[currentColorIndex];
    setLightColor(next.color, next.name, currentColorIndex);
    playClickSound();
    triggerHaptic();
    resetHudTimer();
  }

  // Brightness Control
  function setBrightness(val) {
    brightness = parseInt(val, 10);
    brightnessSlider.value = brightness;
    brightnessText.textContent = brightness + '%';
    
    // Dim layer opacity: 100% -> 0 opacity, 10% -> 0.90 opacity
    const opacity = (100 - brightness) / 100 * 0.92;
    dimLayer.style.opacity = opacity;
  }

  // Fullscreen Management
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function toggleFullscreen() {
    if (!isFullscreen()) {
      const elem = document.documentElement;
      if (elem.requestFullscreen) {
        elem.requestFullscreen().catch(() => {});
      } else if (elem.webkitRequestFullscreen) {
        elem.webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }
  }

  function updateFullscreenIcons() {
    if (isFullscreen()) {
      iconFsEnter.style.display = 'none';
      iconFsExit.style.display = 'block';
    } else {
      iconFsEnter.style.display = 'block';
      iconFsExit.style.display = 'none';
    }
  }

  document.addEventListener('fullscreenchange', updateFullscreenIcons);
  document.addEventListener('webkitfullscreenchange', updateFullscreenIcons);

  // Screen Wake Lock API
  async function requestWakeLock() {
    if (!isWakeLockEnabled) return;
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        if (wakelockStatus) {
          wakelockStatus.textContent = 'Active (Screen won\'t sleep)';
          wakelockStatus.style.color = '#34d399';
        }
        wakeLock.addEventListener('release', () => {
          if (wakelockStatus && isWakeLockEnabled) {
            wakelockStatus.textContent = 'Idle';
            wakelockStatus.style.color = '#9ca3af';
          }
        });
      } catch (err) {
        if (wakelockStatus) {
          wakelockStatus.textContent = 'Unsupported or backgrounded';
        }
      }
    } else if (wakelockStatus) {
      wakelockStatus.textContent = 'Not supported in this browser';
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().then(() => {
        wakeLock = null;
      });
    }
    if (wakelockStatus) {
      wakelockStatus.textContent = 'Disabled';
      wakelockStatus.style.color = '#9ca3af';
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isWakeLockEnabled) {
      requestWakeLock();
    }
  });

  // Strobe & Emergency Flasher
  function stopStrobe() {
    if (strobeInterval) {
      clearInterval(strobeInterval);
      strobeInterval = null;
    }
    strobeMode = 'off';
    dimLayer.style.opacity = (100 - brightness) / 100 * 0.92;
    strobeOffBtn.classList.add('active');
    strobeFastBtn.classList.remove('active');
    strobeSosBtn.classList.remove('active');
  }

  function startFastStrobe() {
    stopStrobe();
    strobeMode = 'fast';
    strobeOffBtn.classList.remove('active');
    strobeFastBtn.classList.add('active');

    let state = false;
    strobeInterval = setInterval(() => {
      state = !state;
      dimLayer.style.opacity = state ? 0 : 1;
    }, 90);
  }

  function startSosStrobe() {
    stopStrobe();
    strobeMode = 'sos';
    strobeOffBtn.classList.remove('active');
    strobeSosBtn.classList.add('active');

    // Morse SOS: ... --- ...
    // Short = 150ms, Long = 450ms, Gap = 150ms, Letter gap = 450ms, Word gap = 1200ms
    const sosSequence = [
      // S: . . .
      { on: 150, off: 150 }, { on: 150, off: 150 }, { on: 150, off: 400 },
      // O: - - -
      { on: 450, off: 150 }, { on: 450, off: 150 }, { on: 450, off: 400 },
      // S: . . .
      { on: 150, off: 150 }, { on: 150, off: 150 }, { on: 150, off: 1200 }
    ];

    let step = 0;
    function runNextStep() {
      if (strobeMode !== 'sos') return;
      const current = sosSequence[step];
      dimLayer.style.opacity = 0; // Light ON
      setTimeout(() => {
        if (strobeMode !== 'sos') return;
        dimLayer.style.opacity = 1; // Light OFF
        setTimeout(() => {
          step = (step + 1) % sosSequence.length;
          runNextStep();
        }, current.off);
      }, current.on);
    }
    runNextStep();
  }

  // HUD Auto-dimming
  function resetHudTimer() {
    hudControls.classList.remove('dimmed');
    clearTimeout(hudTimeout);
    hudTimeout = setTimeout(() => {
      if (!settingsModal.classList.contains('open')) {
        hudControls.classList.add('dimmed');
      }
    }, 3500);
  }

  window.addEventListener('mousemove', resetHudTimer);
  window.addEventListener('touchstart', resetHudTimer);

  // Surface Tap Handler (Single Tap = Color Cycle, Double Tap = Settings)
  let singleTapTimer = null;
  lightSurface.addEventListener('click', (e) => {
    // Attempt wakeLock request on user gesture
    if (!wakeLock && isWakeLockEnabled) {
      requestWakeLock();
    }

    const now = Date.now();
    const diff = now - lastTapTime;

    if (diff < 320 && diff > 0) {
      // Double Tap detected!
      clearTimeout(singleTapTimer);
      singleTapTimer = null;
      openSettings();
      lastTapTime = 0;
      return;
    }

    lastTapTime = now;
    clearTimeout(singleTapTimer);
    singleTapTimer = setTimeout(() => {
      cycleColor();
      singleTapTimer = null;
    }, 240);
  });

  // Settings Modal Open/Close
  function openSettings() {
    settingsModal.classList.add('open');
    hudControls.classList.remove('dimmed');
    clearTimeout(hudTimeout);
  }

  function closeSettings() {
    settingsModal.classList.remove('open');
    resetHudTimer();
  }

  btnSettings.addEventListener('click', (e) => {
    e.stopPropagation();
    openSettings();
  });

  btnCloseSettings.addEventListener('click', (e) => {
    e.stopPropagation();
    closeSettings();
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      closeSettings();
    }
  });

  btnFullscreen.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFullscreen();
  });

  // Color Swatch Buttons
  colorOptions.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const color = btn.getAttribute('data-color');
      const name = btn.getAttribute('data-name');
      setLightColor(color, name);
      playClickSound();
      triggerHaptic();
    });
  });

  // Brightness Slider
  brightnessSlider.addEventListener('input', (e) => {
    setBrightness(e.target.value);
  });

  // Wake Lock Toggle
  toggleWakelock.addEventListener('change', (e) => {
    isWakeLockEnabled = e.target.checked;
    if (isWakeLockEnabled) {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }
  });

  // Sound Toggle
  toggleSound.addEventListener('change', (e) => {
    isSoundEnabled = e.target.checked;
  });

  // Strobe Buttons
  strobeOffBtn.addEventListener('click', stopStrobe);
  strobeFastBtn.addEventListener('click', startFastStrobe);
  strobeSosBtn.addEventListener('click', startSosStrobe);

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      cycleColor();
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.code === 'Escape') {
      if (settingsModal.classList.contains('open')) {
        closeSettings();
      }
    } else if (e.code === 'ArrowUp') {
      e.preventDefault();
      setBrightness(Math.min(100, brightness + 10));
    } else if (e.code === 'ArrowDown') {
      e.preventDefault();
      setBrightness(Math.max(10, brightness - 10));
    }
  });

  // PWA Installation Hook
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (btnInstall) {
      btnInstall.style.display = 'flex';
      btnInstall.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          btnInstall.style.display = 'none';
        }
        deferredPrompt = null;
      });
    }
  });

  // Register Service Worker for Offline PWA
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // Initialize Default State
  setLightColor(COLOR_CYCLE[0].color, COLOR_CYCLE[0].name, 0);
  setBrightness(100);
  resetHudTimer();

  // Hide Intro Toast after 3.8s
  setTimeout(() => {
    if (introToast) {
      introToast.classList.add('fade-out');
      setTimeout(() => introToast.remove(), 700);
    }
  }, 3800);

  // Request Wake Lock on first interaction
  const requestWakeOnFirstInteraction = () => {
    requestWakeLock();
    window.removeEventListener('click', requestWakeOnFirstInteraction);
    window.removeEventListener('touchstart', requestWakeOnFirstInteraction);
  };
  window.addEventListener('click', requestWakeOnFirstInteraction, { once: true });
  window.addEventListener('touchstart', requestWakeOnFirstInteraction, { once: true });

})();
