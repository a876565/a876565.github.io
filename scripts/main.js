import { createOpenCvMatcher } from './opencv-matcher.js';

/** @type {HTMLButtonElement} */
const btnStart = document.getElementById('btn-start');
/** @type {HTMLButtonElement} */
const btnStop = document.getElementById('btn-stop');
/** @type {HTMLButtonElement} */
const btnSelect = document.getElementById('btn-select');
/** @type {HTMLButtonElement} */
const btnClear = document.getElementById('btn-clear');
/** @type {HTMLButtonElement} */
const btnMatch = document.getElementById('btn-match');
/** @type {HTMLInputElement} */
const inputUpload = document.getElementById('target-upload');
/** @type {HTMLUListElement} */
const targetList = document.getElementById('target-list');
/** @type {HTMLCanvasElement} */
const canvas = document.getElementById('display-canvas');
/** @type {HTMLDivElement} */
const overlay = document.getElementById('selection-overlay');
/** @type {HTMLDivElement} */
const statusBar = document.getElementById('status-bar');
/** @type {HTMLVideoElement} */
const video = document.getElementById('capture-video');
/** @type {HTMLDivElement} */
const displayArea = document.querySelector('.display-area');

const ctx = canvas.getContext('2d', { willReadFrequently: true });

// 配置
const MATCH_INTERVAL_MS = 500;
const SIMILARITY_THRESHOLD = 0.85;
const STORAGE_KEY = 'mgui-targets';

// 状态
let stream = null;
let isSelecting = false;
let selection = null; // { x, y, w, h }，基于视频原始分辨率
let isMatching = false;
let matcher = null;
let fallbackMatcher = null;
let rafId = null;
let matchIntervalId = null;
let elapsedIntervalId = null;
let isMatchRunning = false;

/**
 * @typedef {Object} Target
 * @property {string} id
 * @property {string} name
 * @property {string} dataUrl
 * @property {ImageData} imageData
 * @property {Date|null} lastDetectedTime
 * @property {{x:number,y:number,w:number,h:number}|null} lastMatchLocation
 * @property {'detected'|'missing'} status
 */
/** @type {Target[]} */
let targets = [];

// 选择区域交互状态
let selectStart = null;

/**
 * 生成唯一 ID
 */
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * 从 localStorage 加载目标列表（仅包含 id/name/dataUrl）
 * @returns {{id:string,name:string,dataUrl:string}[]}
 */
function loadTargetsFromStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
        return [];
    } catch (err) {
        console.error('读取 localStorage 失败：', err);
        return [];
    }
}

/**
 * 将目标列表保存到 localStorage（仅保存 id/name/dataUrl）
 */
function saveTargetsToStorage() {
    try {
        const storable = targets.map(t => ({
            id: t.id,
            name: t.name,
            dataUrl: t.dataUrl
        }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(storable));
    } catch (err) {
        console.error('写入 localStorage 失败：', err);
        updateStatus('目标保存失败：' + err.message);
    }
}

/**
 * 将 dataUrl 转换为 ImageData
 * @param {string} dataUrl
 * @returns {Promise<ImageData>}
 */
function dataUrlToImageData(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const x = c.getContext('2d');
            x.drawImage(img, 0, 0);
            resolve(x.getImageData(0, 0, c.width, c.height));
        };
        img.onerror = () => reject(new Error('图片解析失败'));
        img.src = dataUrl;
    });
}

/**
 * 将 File 读取为 dataUrl
 * @param {File} file
 * @returns {Promise<string>}
 */
function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsDataURL(file);
    });
}

/**
 * 初始化：加载 OpenCV 匹配器、从 localStorage 恢复目标、渲染列表
 */
async function init() {
    try {
        matcher = await createOpenCvMatcher();
    } catch (err) {
        console.log('OpenCV 初始化失败，将使用 CPU 备用匹配器：', err.message);
        console.error(err);
        fallbackMatcher = createCpuMatcher();
        updateStatus('OpenCV 初始化失败，已切换至 CPU 备用匹配：' + err.message);
    }

    // 从 localStorage 恢复目标
    const stored = loadTargetsFromStorage();
    if (stored.length > 0) {
        try {
            targets = await Promise.all(stored.map(async item => {
                const imageData = await dataUrlToImageData(item.dataUrl);
                return {
                    id: item.id,
                    name: item.name,
                    dataUrl: item.dataUrl,
                    imageData,
                    lastDetectedTime: null,
                    lastMatchLocation: null,
                    status: 'missing'
                };
            }));
            updateStatus(`已恢复 ${targets.length} 个监视目标`);
        } catch (err) {
            console.error('恢复目标失败：', err);
            updateStatus('恢复目标失败：' + err.message);
        }
    }

    renderTargetList();
    elapsedIntervalId = setInterval(updateLastDetectedDisplays, 1000);
    updateButtons();

    if (targets.length === 0) {
        updateStatus('请上传至少一张监视目标图片');
    } else if (matcher || fallbackMatcher) {
        updateStatus('就绪，点击“开始捕获”选择屏幕源');
    }
}

/**
 * 创建基于 CPU 的备用模板匹配器（NCC 归一化互相关）
 */
function createCpuMatcher() {
    return {
        /**
         * @param {ImageData} imageData
         * @param {ImageData} templateData
         * @returns {Promise<{location:{x:number,y:number},similarity:number}>}
         */
        highestSimilarity(imageData, templateData) {
            return new Promise(resolve => {
                const src = imageData.data;
                const tpl = templateData.data;
                const sw = imageData.width;
                const sh = imageData.height;
                const tw = templateData.width;
                const th = templateData.height;

                if (sw < tw || sh < th) {
                    resolve({ location: { x: 0, y: 0 }, similarity: 0 });
                    return;
                }

                let sumTpl = 0;
                let sumTplSq = 0;
                const tplGray = new Float32Array(tw * th);
                for (let ty = 0; ty < th; ty++) {
                    for (let tx = 0; tx < tw; tx++) {
                        const ti = (ty * tw + tx) * 4;
                        const t = (tpl[ti] + tpl[ti + 1] + tpl[ti + 2]) / 3;
                        tplGray[ty * tw + tx] = t;
                        sumTpl += t;
                        sumTplSq += t * t;
                    }
                }
                const tplCount = tw * th;
                const tplMean = sumTpl / tplCount;
                const tplDenom = Math.sqrt(sumTplSq - sumTpl * tplMean);

                let bestSimilarity = -Infinity;
                let bestX = 0;
                let bestY = 0;

                for (let y = 0; y <= sh - th; y++) {
                    for (let x = 0; x <= sw - tw; x++) {
                        let sumSrc = 0;
                        let sumSrcSq = 0;
                        let sumProd = 0;

                        for (let ty = 0; ty < th; ty++) {
                            for (let tx = 0; tx < tw; tx++) {
                                const si = ((y + ty) * sw + (x + tx)) * 4;
                                const s = (src[si] + src[si + 1] + src[si + 2]) / 3;
                                const t = tplGray[ty * tw + tx];
                                sumSrc += s;
                                sumSrcSq += s * s;
                                sumProd += s * t;
                            }
                        }

                        const srcMean = sumSrc / tplCount;
                        const numerator = sumProd - sumSrc * tplMean;
                        const denom = Math.sqrt(sumSrcSq - sumSrc * srcMean) * tplDenom;
                        const similarity = denom === 0 ? 0 : numerator / denom;

                        if (similarity > bestSimilarity) {
                            bestSimilarity = similarity;
                            bestX = x;
                            bestY = y;
                        }
                    }
                }

                resolve({
                    location: { x: bestX, y: bestY },
                    similarity: (bestSimilarity + 1) / 2
                });
            });
        }
    };
}

/**
 * 渲染目标图像列表
 */
function renderTargetList() {
    // 保留上传按钮项，最后重新放回列表末尾
    const uploadItem = targetList.querySelector('.target-upload');
    targetList.innerHTML = '';

    if (targets.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'target-item target-empty';
        empty.textContent = '暂无监视目标，请点击 + 上传图片';
        targetList.appendChild(empty);
    } else {
        targets.forEach(target => {
        const li = document.createElement('li');
        li.className = 'target-item';
        li.dataset.targetId = target.id;

        const lastText = target.lastDetectedTime
            ? formatElapsed(target.lastDetectedTime)
            : '上次检测到：-';

        li.innerHTML = `
            <img class="target-thumb" src="${target.dataUrl}" alt="${target.name}">
            <div class="target-info">
                <span class="target-name" title="${target.name}">${target.name}</span>
                <span class="target-status">
                    状态：<span class="status-badge ${target.status === 'detected' ? 'status-detected' : 'status-missing'}" id="badge-${target.id}">
                        ${target.status === 'detected' ? '已检测到' : '未检测到'}
                    </span>
                </span>
                <span class="last-detected" id="last-${target.id}">${lastText}</span>
            </div>
            <button class="btn btn-icon target-delete" data-id="${target.id}" title="删除">×</button>
        `;
        targetList.appendChild(li);
    });

        // 绑定删除按钮
        targetList.querySelectorAll('.target-delete').forEach(btn => {
            btn.addEventListener('click', () => deleteTarget(btn.dataset.id));
        });
    }

    // 上传按钮始终放在列表末尾
    if (uploadItem) {
        targetList.appendChild(uploadItem);
    }
}

/**
 * 更新单个目标的状态 UI
 * @param {Target} target
 */
function updateTargetStatusUI(target) {
    const badge = document.getElementById(`badge-${target.id}`);
    const last = document.getElementById(`last-${target.id}`);
    if (!badge || !last) return;

    if (target.status === 'detected') {
        badge.textContent = '已检测到';
        badge.className = 'status-badge status-detected';
    } else {
        badge.textContent = '未检测到';
        badge.className = 'status-badge status-missing';
    }

    last.textContent = target.lastDetectedTime
        ? formatElapsed(target.lastDetectedTime)
        : '上次检测到：-';
}

/**
 * 格式化距上次检测的秒数
 * @param {Date} time
 */
function formatElapsed(time) {
    const seconds = Math.floor((Date.now() - time.getTime()) / 1000);
    return `上次检测到：${seconds} 秒前`;
}

/**
 * 更新所有目标的“距上次检测”显示
 */
function updateLastDetectedDisplays() {
    targets.forEach(target => {
        if (target.lastDetectedTime) {
            updateTargetStatusUI(target);
        }
    });
}

/**
 * 更新底部状态栏
 */
function updateStatus(msg) {
    statusBar.textContent = msg;
}

/**
 * 根据当前状态设置按钮可用性
 */
function updateButtons() {
    const hasTargets = targets.length > 0;
    const hasStream = !!stream;

    btnStart.disabled = hasStream;
    btnStop.disabled = !hasStream;
    btnSelect.disabled = !hasStream;
    btnClear.disabled = !(hasStream && selection);
    btnMatch.disabled = !(hasStream && hasTargets);
}

/**
 * 开始屏幕捕获
 */
async function startCapture() {
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: 'always' },
            audio: false
        });
        video.srcObject = stream;

        await new Promise((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error('视频加载失败'));
        });
        await video.play();

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        updateStatus('捕获已开始');
        updateButtons();
        startRenderLoop();

        stream.getVideoTracks()[0].onended = () => {
            stopCapture();
        };
    } catch (err) {
        console.error(err);
        if (err.name === 'AbortError' || err.message?.includes('cancel')) {
            updateStatus('用户取消了屏幕共享');
        } else {
            updateStatus('捕获失败：' + err.message);
        }
    }
}

/**
 * 停止屏幕捕获并清理资源
 */
function stopCapture() {
    stopRenderLoop();
    stopMatching();

    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    video.srcObject = null;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    overlay.classList.add('hidden');
    selection = null;

    updateStatus('捕获已停止');
    updateButtons();
}

/**
 * 启动渲染循环
 */
function startRenderLoop() {
    if (rafId) cancelAnimationFrame(rafId);

    function loop() {
        if (!stream || video.paused || video.ended) return;
        renderFrame();
        rafId = requestAnimationFrame(loop);
    }
    loop();
}

/**
 * 停止渲染循环
 */
function stopRenderLoop() {
    if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
}

/**
 * 将当前帧绘制到 canvas
 */
function renderFrame() {
    if (!selection) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } else {
        ctx.drawImage(
            video,
            selection.x, selection.y, selection.w, selection.h,
            0, 0, canvas.width, canvas.height
        );
    }

    // 绘制所有检测到的目标框
    targets.forEach(target => {
        if (target.lastMatchLocation) {
            drawMatchBoxForTarget(target);
        }
    });
}

/**
 * 绘制单个目标的匹配位置标记框
 * @param {Target} target
 */
function drawMatchBoxForTarget(target) {
    if (!target.lastMatchLocation) return;
    const { x, y, w, h } = target.lastMatchLocation;

    let drawX = x;
    let drawY = y;
    let drawW = w;
    let drawH = h;

    if (selection) {
        const scaleX = canvas.width / selection.w;
        const scaleY = canvas.height / selection.h;
        drawX *= scaleX;
        drawY *= scaleY;
        drawW *= scaleX;
        drawH *= scaleY;
    }

    drawMatchBox(drawX, drawY, drawW, drawH);
}

/**
 * 在 canvas 上绘制匹配位置标记框
 */
function drawMatchBox(x, y, w, h) {
    ctx.save();
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 4;
    ctx.strokeRect(x, y, w, h);

    ctx.fillStyle = 'rgba(0, 255, 0, 0.2)';
    ctx.fillRect(x, y, w, h);

    ctx.beginPath();
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    ctx.moveTo(x + w / 2, y);
    ctx.lineTo(x + w / 2, y + h);
    ctx.moveTo(x, y + h / 2);
    ctx.lineTo(x + w, y + h / 2);
    ctx.stroke();
    ctx.restore();
}

/**
 * 开始/停止模板匹配
 */
function toggleMatching() {
    if (isMatching) {
        stopMatching();
    } else {
        startMatching();
    }
}

/**
 * 启动匹配循环
 */
function startMatching() {
    if (!stream || targets.length === 0) return;
    isMatching = true;
    btnMatch.textContent = '停止匹配';
    btnMatch.classList.add('btn-active');
    updateStatus('匹配中...');

    runMatch();
    matchIntervalId = setInterval(runMatch, MATCH_INTERVAL_MS);
}

/**
 * 停止匹配循环
 */
function stopMatching() {
    isMatching = false;
    targets.forEach(t => {
        t.lastMatchLocation = null;
    });
    if (matchIntervalId) {
        clearInterval(matchIntervalId);
        matchIntervalId = null;
    }
    btnMatch.textContent = '开始匹配';
    btnMatch.classList.remove('btn-active');
    if (stream) {
        updateStatus('匹配已停止');
    }
}

/**
 * 执行一次模板匹配（遍历所有目标）
 */
async function runMatch() {
    const currentMatcher = matcher || fallbackMatcher;
    if (isMatchRunning || !stream || targets.length === 0 || !currentMatcher) return;
    isMatchRunning = true;

    try {
        const sourceData = getSourceImageData();
        let detectedCount = 0;
        let lastDetectedTarget = null;

        for (const target of targets) {
            const match = await currentMatcher.highestSimilarity(sourceData, target.imageData);
            const detected = match.similarity >= SIMILARITY_THRESHOLD;

            if (detected) {
                target.status = 'detected';
                target.lastDetectedTime = new Date();
                target.lastMatchLocation = {
                    x: match.location.x,
                    y: match.location.y,
                    w: target.imageData.width,
                    h: target.imageData.height
                };
                detectedCount++;
                lastDetectedTarget = { target, match };
            } else {
                target.status = 'missing';
                target.lastMatchLocation = null;
            }

            updateTargetStatusUI(target);
        }

        if (detectedCount > 0 && lastDetectedTarget) {
            const { target, match } = lastDetectedTarget;
            updateStatus(`已检测到 ${detectedCount} 个目标，最近：${target.name} (${match.location.x}, ${match.location.y})`);
        } else {
            updateStatus('未检测到目标');
        }
    } catch (err) {
        console.error('匹配出错：', err);
        updateStatus('匹配出错：' + err.message);
    } finally {
        isMatchRunning = false;
    }
}

/**
 * 获取当前用于匹配的图像数据
 */
function getSourceImageData() {
    const c = document.createElement('canvas');
    const x = c.getContext('2d');

    if (!selection) {
        c.width = video.videoWidth;
        c.height = video.videoHeight;
        x.drawImage(video, 0, 0);
    } else {
        c.width = selection.w;
        c.height = selection.h;
        x.drawImage(
            video,
            selection.x, selection.y, selection.w, selection.h,
            0, 0, selection.w, selection.h
        );
    }

    return x.getImageData(0, 0, c.width, c.height);
}

/**
 * 将页面客户区坐标转换为 canvas 内部坐标
 */
function clientToCanvas(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY
    };
}

/**
 * 处理用户上传的目标图片
 */
async function handleTargetUpload() {
    const files = Array.from(inputUpload.files || []);
    if (files.length === 0) return;

    const currentMatcher = matcher || fallbackMatcher;
    if (!currentMatcher) {
        updateStatus('匹配器尚未初始化，请稍后再试');
        return;
    }

    let added = 0;
    for (const file of files) {
        try {
            const dataUrl = await fileToDataUrl(file);
            const imageData = await dataUrlToImageData(dataUrl);

            targets.push({
                id: generateId(),
                name: file.name,
                dataUrl,
                imageData,
                lastDetectedTime: null,
                lastMatchLocation: null,
                status: 'missing'
            });
            added++;
        } catch (err) {
            console.error('上传目标失败：', file.name, err);
            updateStatus(`上传失败：${file.name}`);
        }
    }

    inputUpload.value = '';
    if (added > 0) {
        saveTargetsToStorage();
        renderTargetList();
        updateButtons();
        updateStatus(`已添加 ${added} 个监视目标`);
    }
}

/**
 * 删除指定目标
 * @param {string} id
 */
function deleteTarget(id) {
    targets = targets.filter(t => t.id !== id);
    saveTargetsToStorage();
    renderTargetList();
    updateButtons();
    if (targets.length === 0 && isMatching) {
        stopMatching();
    }
    updateStatus('目标已删除');
}

/**
 * 进入/退出区域选择模式
 */
function toggleSelectionMode() {
    if (isSelecting) {
        exitSelectionMode();
        updateStatus('已取消选择');
    } else {
        enterSelectionMode();
    }
}

function enterSelectionMode() {
    if (!stream) return;
    isSelecting = true;
    btnSelect.textContent = '取消选择';
    btnSelect.classList.add('btn-active');
    canvas.style.cursor = 'crosshair';
    updateStatus('请在画面上拖拽选择要监视的区域');

    if (selection) {
        clearSelection();
    }
}

function exitSelectionMode() {
    isSelecting = false;
    btnSelect.textContent = '选择区域';
    btnSelect.classList.remove('btn-active');
    canvas.style.cursor = 'crosshair';
    selectStart = null;
    overlay.classList.add('hidden');
}

/**
 * 清除选择区域
 */
function clearSelection() {
    selection = null;
    targets.forEach(t => { t.lastMatchLocation = null; });
    overlay.classList.add('hidden');
    if (stream) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        renderFrame();
    }
    updateButtons();
    updateStatus('区域已清除，恢复全屏监视');
}

// 鼠标事件：选择区域
canvas.addEventListener('mousedown', (e) => {
    if (!isSelecting) return;
    e.preventDefault();
    selectStart = clientToCanvas(e.clientX, e.clientY);
    overlay.classList.remove('hidden');
    updateOverlay(selectStart.x, selectStart.y, 0, 0);
});

window.addEventListener('mousemove', (e) => {
    if (!isSelecting || !selectStart) return;
    const p = clientToCanvas(e.clientX, e.clientY);
    const x = Math.min(selectStart.x, p.x);
    const y = Math.min(selectStart.y, p.y);
    const w = Math.abs(p.x - selectStart.x);
    const h = Math.abs(p.y - selectStart.y);
    updateOverlay(x, y, w, h);
});

window.addEventListener('mouseup', (e) => {
    if (!isSelecting || !selectStart) return;
    const p = clientToCanvas(e.clientX, e.clientY);
    let x = Math.min(selectStart.x, p.x);
    let y = Math.min(selectStart.y, p.y);
    let w = Math.abs(p.x - selectStart.x);
    let h = Math.abs(p.y - selectStart.y);

    x = Math.max(0, Math.min(x, canvas.width));
    y = Math.max(0, Math.min(y, canvas.height));
    w = Math.min(w, canvas.width - x);
    h = Math.min(h, canvas.height - y);

    selectStart = null;
    overlay.classList.add('hidden');

    if (w > 10 && h > 10) {
        selection = { x, y, w, h };
        renderFrame();
        updateButtons();
        updateStatus(`已选择区域：x=${Math.round(x)} y=${Math.round(y)} w=${Math.round(w)} h=${Math.round(h)}`);
    } else {
        updateStatus('选择区域太小，请重新选择');
    }

    exitSelectionMode();
});

/**
 * 更新选择区域覆盖层的位置和大小（使用 CSS 像素）
 */
function updateOverlay(x, y, w, h) {
    const canvasRect = canvas.getBoundingClientRect();
    const areaRect = displayArea.getBoundingClientRect();
    const scaleX = canvasRect.width / canvas.width;
    const scaleY = canvasRect.height / canvas.height;

    overlay.style.left = (canvasRect.left - areaRect.left + x * scaleX) + 'px';
    overlay.style.top = (canvasRect.top - areaRect.top + y * scaleY) + 'px';
    overlay.style.width = (w * scaleX) + 'px';
    overlay.style.height = (h * scaleY) + 'px';
}

// 按钮事件绑定
btnStart.addEventListener('click', startCapture);
btnStop.addEventListener('click', stopCapture);
btnSelect.addEventListener('click', toggleSelectionMode);
btnClear.addEventListener('click', clearSelection);
btnMatch.addEventListener('click', toggleMatching);
inputUpload.addEventListener('change', handleTargetUpload);

// 页面卸载时清理
window.addEventListener('beforeunload', () => {
    stopCapture();
});

init();
