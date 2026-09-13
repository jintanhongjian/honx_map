/**
 * 思维导图编辑器
 * 基于 jsMind 0.9.1，支持编辑、保存到本地、导出 PNG / PDF / Word
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'honx_mindmap_data';
    var STORAGE_TITLE_KEY = 'honx_mindmap_title';

    /** 默认思维导图数据（node_tree 格式） */
    function getDefaultMind() {
        return {
            meta: { name: '我的思维导图', author: 'honx_map', version: '0.1' },
            format: 'node_tree',
            data: {
                id: 'root',
                topic: '中心主题',
                children: [
                    {
                        id: 'sub1',
                        topic: '分支一',
                        direction: 'left',
                        children: [
                            { id: 'sub1_1', topic: '子主题 1' },
                            { id: 'sub1_2', topic: '子主题 2' },
                        ],
                    },
                    {
                        id: 'sub2',
                        topic: '分支二',
                        direction: 'right',
                        children: [
                            { id: 'sub2_1', topic: '子主题 1' },
                            { id: 'sub2_2', topic: '子主题 2' },
                        ],
                    },
                ],
            },
        };
    }

    /** jsMind 实例 */
    var jm = null;
    var titleInput = document.getElementById('mind-title');
    var statusEl = document.getElementById('status');
    var outlineEl = document.getElementById('outline');
    var sidebarEl = document.getElementById('sidebar');
    var containerEl = document.getElementById('jsmind_container');
    var inspectorEl = document.getElementById('inspector');
    var inspectorBody = document.getElementById('inspector-body');
    var inspectorTopic = document.getElementById('inspector-node-topic');
    var inspectorTitle = document.getElementById('inspector-title');
    var pagePropsEl = document.getElementById('page-props');
    var btnToggleInspector = document.getElementById('btn-toggle-inspector');
    var ctxMenu = document.getElementById('ctx-menu');
    var emojiPanel = document.getElementById('emoji-panel');
    var emojiTabs = document.getElementById('emoji-tabs');
    var emojiGrid = document.getElementById('emoji-grid');
    var imageInput = document.getElementById('image-input');
    var saveTimer = null;
    /** 大纲中最后聚焦的节点，用于重绘后恢复焦点 */
    var lastActiveNodeId = null;
    /** 当前选中节点 id 与表情目录 */
    var selectedNodeId = null;
    var emojiCatalog = null;

    /** 获取导图名称（用于导出文件名） */
    function getMindName() {
        var name = titleInput.value.trim();
        return name || '思维导图';
    }

    /** 状态提示 */
    function showStatus(msg) {
        statusEl.textContent = msg;
        statusEl.classList.add('show');
        setTimeout(function () {
            statusEl.classList.remove('show');
        }, 2000);
    }

    /** 下载 Blob 到本地 */
    function downloadBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 1000);
    }

    /** 自动保存到浏览器 localStorage（防抖） */
    function autoSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
            try {
                var data = jm.get_data('node_tree');
                data.meta.name = getMindName();
                localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
                localStorage.setItem(STORAGE_TITLE_KEY, getMindName());
                showStatus('已自动保存到浏览器');
            } catch (e) {
                console.error('自动保存失败', e);
            }
        }, 800);
    }

    /* ---------------- 脏标记（未保存修改跟踪） ---------------- */
    // isDirty 表示自上次「保存到文件」后是否有修改。编辑事件置脏，保存后清除。
    var isDirty = false;
    function markDirty() { isDirty = true; }
    function clearDirty() { isDirty = false; }

    /* ---------------- 撤销 / 重做 ---------------- */

    /**
     * 编辑历史栈：每次编辑后保存当前导图快照。
     * undoStack/pointer 指向当前状态；undo 回退、redo 前进。
     * 快照为 node_tree 数据（含 flow-edges / 位置偏移等自定义字段）。
     */
    var undoStack = [];
    var undoPointer = -1;
    var isRestoring = false; // 恢复中不记录历史，防止撤销/重做本身入栈
    var isRestoringSnapshot = false; // 恢复快照期间抑制 applyTreeOffsets，避免偏移二次叠加
    var HISTORY_LIMIT = 50;

    function snapshotMind() {
        try {
            return JSON.parse(JSON.stringify(jm.get_data('node_tree')));
        } catch (e) {
            return null;
        }
    }

    function recordHistory() {
        if (isRestoring) return;
        var snap = snapshotMind();
        if (!snap) return;
        // 丢弃 pointer 之后的 redo 分支
        undoStack = undoStack.slice(0, undoPointer + 1);
        undoStack.push(snap);
        if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
        undoPointer = undoStack.length - 1;
        updateUndoRedoButtons();
    }

    function restoreSnapshot(snap) {
        if (!snap) return;
        isRestoring = true;
        isRestoringSnapshot = true;
        jm.show(snap);
        isRestoring = false;
        renderOutline();
        applyCustomNodeStyles();
        applyJunctionStyles();
        applyTreeOffsets();
        isRestoringSnapshot = false;
        redrawFlowEdges();
        autoSave();
    }

    function undo() {
        if (undoPointer <= 0) {
            showStatus('没有可撤销的操作');
            return;
        }
        undoPointer--;
        restoreSnapshot(undoStack[undoPointer]);
        updateUndoRedoButtons();
        showStatus('已撤销');
    }

    function redo() {
        if (undoPointer >= undoStack.length - 1) {
            showStatus('没有可重做的操作');
            return;
        }
        undoPointer++;
        restoreSnapshot(undoStack[undoPointer]);
        updateUndoRedoButtons();
        showStatus('已重做');
    }

    function updateUndoRedoButtons() {
        document.getElementById('btn-undo').disabled = undoPointer <= 0;
        document.getElementById('btn-redo').disabled = undoPointer >= undoStack.length - 1;
    }

    function initHistory() {
        // 初始快照
        var snap = snapshotMind();
        if (snap) {
            undoStack = [snap];
            undoPointer = 0;
        }
        updateUndoRedoButtons();
    }

    /* ---------------- 流程图（有向连线 / 循环 / 接头节点） ---------------- */

    /**
     * 连线数据存放在根节点的 flow-edges 字段，随 node_tree 一起序列化往返。
     * 结构：[{ id, from, to, type: 'arrow'|'line'|'loop', color? }]
     */
    var flowCanvas = null;
    var flowCtx = null;
    var interactionMode = 'select'; // 'select' | 'edge'
    var edgeSourceId = null;
    var selectedEdgeId = null;
    var selectedTreeLink = null; // 选中的树形连线 { parentId, childId }
    var edgePanelEl = document.getElementById('edge-panel');

    function getFlowEdges() {
        // 统一从运行时根节点 data 读取，保证与 saveFlowEdges 写入同步。
        // （jm.get_data() 序列化读可能滞后，导致连续拖拽时读到旧 edges）
        var root = jm.get_node('root');
        return (root && root.data['flow-edges']) || [];
    }

    function saveFlowEdges(edges) {
        // 直接写入根节点运行时数据并自动保存，不做完整重建（jm.show），
        // 避免重建 DOM 导致连续拖拽连线时节点引用/坐标失效。
        var root = jm.get_node('root');
        if (!root) return;
        if (edges && edges.length) {
            root.data['flow-edges'] = edges;
        } else {
            delete root.data['flow-edges'];
        }
        autoSave();
    }

    function initFlowLayer() {
        var panel = jm.view.e_panel;
        flowCanvas = document.createElement('canvas');
        flowCanvas.className = 'flow-canvas';
        flowCtx = flowCanvas.getContext('2d');
        panel.insertBefore(flowCanvas, jm.view.e_nodes);
        // jmnodes 层覆盖整个画布且在其上层，flow canvas 无法直接接收点击，
        // 改在容器上捕获点击做连线命中检测
        containerEl.addEventListener('click', onContainerClickForEdge, true);
        redrawFlowEdges();
    }

    /** 容器点击：若命中连线则选中（不干扰节点点击） */
    function onContainerClickForEdge(e) {
        if (interactionMode === 'edge') return; // 连线模式下由节点点击处理
        if (e.target.closest('jmnode')) return; // 点在节点上不处理连线
        // 点在 expander（展开/收起点）上不处理连线，避免误拦截 expander 点击
        if (e.target.closest('jmexpander')) return;
        if (!flowCanvas) return;
        var cr = flowCanvas.getBoundingClientRect();
        var x = e.clientX - cr.left, y = e.clientY - cr.top;
        var hit = null;
        var edges = getFlowEdges();
        for (var i = 0; i < edges.length; i++) {
            if (isPointOnEdge(edges[i], x, y)) { hit = edges[i]; break; }
        }
        if (hit) {
            e.stopPropagation();
            selectedEdgeId = hit.id;
            selectedTreeLink = null;
            showEdgePanel(e.clientX, e.clientY, hit);
            redrawFlowEdges();
            return;
        }
        // 未命中流程连线，检测树形连线（父子连线）
        var treeHit = hitTestTreeLink(x, y);
        if (treeHit) {
            e.stopPropagation();
            selectedTreeLink = treeHit;
            selectedEdgeId = null;
            showTreeLinkPanel(e.clientX, e.clientY, treeHit);
            redrawFlowEdges();
            jm.view.show_lines();
            return;
        }
        // 都没命中：清除选中
        if (selectedEdgeId || selectedTreeLink) {
            selectedEdgeId = null;
            selectedTreeLink = null;
            hideEdgePanel();
            redrawFlowEdges();
            jm.view.show_lines();
        }
    }

    /** 判断连线是否被区域选择高亮（用于加粗） */
    function isEdgeInRegion(edgeId) {
        return regionSelection && regionSelection.edgeIds.indexOf(edgeId) >= 0;
    }

    function resizeFlowCanvas() {
        if (!flowCanvas) return;
        var size = jm.view.size;
        var dpr = jm.view.device_pixel_ratio || 1;
        flowCanvas.width = size.w * dpr;
        flowCanvas.height = size.h * dpr;
        flowCanvas.style.width = size.w + 'px';
        flowCanvas.style.height = size.h + 'px';
        flowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /**
     * 获取节点中心坐标（相对 flow canvas 可视坐标）
     * 节点 style.left/top 是 panel 内容坐标，flow canvas 是绝对定位（随 panel 滚动），
     * 因此需用 getBoundingClientRect 转换到同一可视坐标系。
     */
    function getNodeCenter(nodeid) {
        var node = jm.get_node(nodeid);
        if (!node) return null;
        var el = node._data.view.element;
        if (!el) return null;
        var nr = el.getBoundingClientRect();
        var cr = flowCanvas.getBoundingClientRect();
        return {
            x: nr.left - cr.left + nr.width / 2,
            y: nr.top - cr.top + nr.height / 2,
            w: nr.width,
            h: nr.height,
        };
    }

    function edgePoints(fromId, toId) {
        var a = getNodeCenter(fromId), b = getNodeCenter(toId);
        if (!a || !b) return null;
        var dx = b.x - a.x, dy = b.y - a.y;
        var s = rectEdgePoint(a, dx, dy);
        var e = rectEdgePoint(b, -dx, -dy);
        return { sx: s.x, sy: s.y, ex: e.x, ey: e.y, angle: Math.atan2(e.y - s.y, e.x - s.x) };
    }

    function rectEdgePoint(rect, dx, dy) {
        if (dx === 0 && dy === 0) return { x: rect.x, y: rect.y };
        var hw = rect.w / 2, hh = rect.h / 2;
        var scaleX = dx !== 0 ? hw / Math.abs(dx) : Infinity;
        var scaleY = dy !== 0 ? hh / Math.abs(dy) : Infinity;
        var scale = Math.min(scaleX, scaleY);
        return { x: rect.x + dx * scale, y: rect.y + dy * scale };
    }

    function drawArrowhead(x, y, angle, size, color) {
        flowCtx.save();
        flowCtx.fillStyle = color;
        flowCtx.translate(x, y);
        flowCtx.rotate(angle);
        flowCtx.beginPath();
        flowCtx.moveTo(0, 0);
        flowCtx.lineTo(-size, -size * 0.45);
        flowCtx.lineTo(-size, size * 0.45);
        flowCtx.closePath();
        flowCtx.fill();
        flowCtx.restore();
    }

    function redrawFlowEdges() {
        if (!flowCtx) return;
        resizeFlowCanvas();
        flowCtx.clearRect(0, 0, jm.view.size.w, jm.view.size.h);
        // 先画独立节点与其后代的父子连线（按实际覆盖后的位置）
        drawFloatingSubtreeLines();
        // 再画有自由偏移的树节点子树的父子连线（jsMind 树形连线已被拦截跳过）
        drawOffsetSubtreeLines();
        // 再画用户创建的流程连线
        getFlowEdges().forEach(function (edge) {
            var color = edge.color || '#c0392b';
            var width = (edge.id === selectedEdgeId || isEdgeInRegion(edge.id)) ? 3 : 2;
            drawFlowEdge(edge, color, width);
        });
    }

    /** 画独立节点子树的父子连线（jsMind 树形连线已跳过这些，需在此补画） */
    function drawFloatingSubtreeLines() {
        var data = jm.get_data('node_tree');
        (function walk(n) {
            if (n.floating) {
                // 递归画该独立节点内部所有父子连线
                drawSubtreeLinks(n);
            }
            (n.children || []).forEach(walk);
        })(data.data);
    }

    /** 正在拖动的树节点集合（用于拖动中识别偏移子树，实时重画连线） */
    var activeDragIds = null;

    /** 画「有自由偏移的树节点子树」的父子连线。jsMind 原生树形连线用纯净的
        layout.offset（无偏移）会画在基准位置与节点脱节，故这些子树的连线由
        draw_line 拦截跳过，此处基于元素实际位置（getBoundingClientRect）重画。 */
    function drawOffsetSubtreeLines() {
        var data = jm.get_data('node_tree');
        (function walk(n, insideOffset) {
            var node = jm.get_node(n.id);
            // 独立节点（floating）是自由体系：不画它到父级的连线，也不再向内传递偏移继承
            if (node && node.data && node.data.floating) return;
            var isAnchor = node && ((node.data && (node.data['offset-x'] || node.data['offset-y'])) || (activeDragIds && activeDragIds[n.id]));
            var nowInside = insideOffset || isAnchor;
            // 在偏移子树内的非根节点：画 父->子 连线（根节点的入线由 jsMind 画，root 无父）
            if (nowInside && node && !node.isroot && node.parent) {
                drawParentChildLink(node.parent, node, node.data && node.data['leading-line-color']);
            }
            (n.children || []).forEach(function (c) { walk(c, nowInside); });
        })(data.data, false);
    }

    /** 基于元素实际位置画父子连线（贝塞尔曲线，方向自适应） */
    function drawParentChildLink(parentNode, childNode, color) {
        var childEl = childNode._data.view.element;
        var parentEl = parentNode._data.view.element;
        if (!childEl || !parentEl) return;
        if (childEl.style.display === 'none' || childEl.getBoundingClientRect().width === 0) return;
        var a = getNodeCenter(parentNode.id);
        var b = getNodeCenter(childNode.id);
        if (!a || !b) return;
        // 方向：子节点在父左侧则从父左缘出、子右缘入；反之亦然
        var dir = b.x >= a.x ? 1 : -1;
        var sx = a.x + dir * a.w / 2;
        var ex = b.x - dir * b.w / 2;
        // 选中的树形连线高亮加粗
        var isSel = selectedTreeLink && selectedTreeLink.childId === childNode.id;
        flowCtx.strokeStyle = isSel ? '#4a90e2' : (color || '#555');
        flowCtx.lineWidth = isSel ? 3 : 2;
        flowCtx.lineCap = 'round';
        flowCtx.beginPath();
        flowCtx.moveTo(sx, a.y);
        flowCtx.bezierCurveTo(sx + 30 * dir, a.y, ex - 30 * dir, b.y, ex, b.y);
        flowCtx.stroke();
    }

    function drawSubtreeLinks(treeNode) {
        var children = treeNode.children || [];
        children.forEach(function (child) {
            // 收起或节点被隐藏时不画该子树的连线（防止连线偏出画布）
            var childNode = jm.get_node(child.id);
            var parentNode = jm.get_node(treeNode.id);
            var childVisible = childNode && childNode._data.view.element &&
                childNode._data.view.element.getBoundingClientRect().width > 0;
            if (!childVisible) return;
            drawParentChildLink(parentNode, childNode, '#555');
            drawSubtreeLinks(child);
        });
    }

    /** 判断节点是否可见（自身或其任一祖先被收起/隐藏则不画连线） */
    function isNodeVisible(nodeid) {
        var node = jm.get_node(nodeid);
        if (!node) return false;
        var el = node._data.view.element;
        // 元素被隐藏（display:none 或尺寸为 0）则不可见
        if (!el || el.getBoundingClientRect().width === 0) return false;
        // 祖先被收起：jsMind 会把被收起的后代 display:none，上面已覆盖；
        // 独立节点子树收起时由 hideFloatingDescendants 隐藏，同样覆盖。
        return true;
    }

    function drawFlowEdge(edge, color, width) {
        // 任一端点不可见（节点收起隐藏）时不画该连线
        if (!isNodeVisible(edge.from) || !isNodeVisible(edge.to)) return;
        var pts = edgePoints(edge.from, edge.to);
        if (!pts) return;
        flowCtx.strokeStyle = color;
        flowCtx.lineWidth = width;
        flowCtx.lineCap = 'round';
        var isLoop = edge.type === 'loop' || edge.from === edge.to;
        if (isLoop) {
            drawLoop(edge, color);
            return;
        }
        var shape = edge.shape || 'curve';
        // bend: -100~100，映射为控制点偏移比例
        var bendRatio = (edge.bend != null ? edge.bend : 15) / 100;
        var mx = (pts.sx + pts.ex) / 2, my = (pts.sy + pts.ey) / 2;
        var nx = -(pts.ey - pts.sy), ny = pts.ex - pts.sx;
        var len = Math.sqrt(nx * nx + ny * ny) || 1;

        flowCtx.beginPath();
        flowCtx.moveTo(pts.sx, pts.sy);
        if (shape === 'straight') {
            flowCtx.lineTo(pts.ex, pts.ey);
        } else if (shape === 'elbow') {
            // 肘形：先水平后垂直（或反之，根据主方向）
            var midX, midY;
            if (Math.abs(pts.ex - pts.sx) > Math.abs(pts.ey - pts.sy)) {
                midX = pts.ex; midY = pts.sy; // 水平优先
            } else {
                midX = pts.sx; midY = pts.ey; // 垂直优先
            }
            flowCtx.lineTo(midX, midY);
            flowCtx.lineTo(pts.ex, pts.ey);
        } else {
            // 曲线：bend 控制弧度，可正可负（反向弯曲避开节点）
            var bend = len * bendRatio;
            var cx = mx + (nx / len) * bend, cy = my + (ny / len) * bend;
            flowCtx.quadraticCurveTo(cx, cy, pts.ex, pts.ey);
        }
        flowCtx.stroke();
        if (edge.type === 'arrow') {
            var ang;
            if (shape === 'curve') {
                var bend2 = len * bendRatio;
                var ccx = mx + (nx / len) * bend2, ccy = my + (ny / len) * bend2;
                ang = Math.atan2(pts.ey - ccy, pts.ex - ccx);
            } else if (shape === 'elbow') {
                // 肘形箭头朝向最后一段
                var lastDx = pts.ex - (Math.abs(pts.ex - pts.sx) > Math.abs(pts.ey - pts.sy) ? pts.ex : pts.sx);
                var lastDy = pts.ey - (Math.abs(pts.ex - pts.sx) > Math.abs(pts.ey - pts.sy) ? pts.sy : pts.ey);
                ang = Math.atan2(lastDy, lastDx);
            } else {
                ang = Math.atan2(pts.ey - pts.sy, pts.ex - pts.sx);
            }
            drawArrowhead(pts.ex, pts.ey, ang, 10, color);
        }
    }

    function drawLoop(edge, color) {
        var c = getNodeCenter(edge.from);
        if (!c) return;
        var r = Math.max(c.w, c.h) / 2 + 18;
        var startAngle = -Math.PI / 3, endAngle = Math.PI / 1.6;
        flowCtx.beginPath();
        flowCtx.arc(c.x, c.y, r, startAngle, endAngle);
        flowCtx.stroke();
        var ax = c.x + r * Math.cos(endAngle), ay = c.y + r * Math.sin(endAngle);
        drawArrowhead(ax, ay, endAngle + Math.PI / 2, 9, color);
    }

    function onFlowCanvasClick(e) {
        var rect = flowCanvas.getBoundingClientRect();
        var x = e.clientX - rect.left, y = e.clientY - rect.top;
        var hit = null;
        var edges = getFlowEdges();
        for (var i = 0; i < edges.length; i++) {
            if (isPointOnEdge(edges[i], x, y)) { hit = edges[i]; break; }
        }
        if (hit) {
            selectedEdgeId = hit.id;
            showEdgePanel(e.clientX, e.clientY, hit);
        } else {
            selectedEdgeId = null;
            hideEdgePanel();
        }
        redrawFlowEdges();
    }

    function isPointOnEdge(edge, px, py) {
        var pts = edgePoints(edge.from, edge.to);
        if (!pts) return false;
        var threshold = 14; // 加宽命中范围，便于点击
        if (edge.type === 'loop' || edge.from === edge.to) {
            var c = getNodeCenter(edge.from);
            var r = Math.max(c.w, c.h) / 2 + 18;
            return Math.abs(Math.hypot(px - c.x, py - c.y) - r) < threshold;
        }
        var shape = edge.shape || 'curve';
        var bendRatio = (edge.bend != null ? edge.bend : 15) / 100;
        var mx = (pts.sx + pts.ex) / 2, my = (pts.sy + pts.ey) / 2;
        var nx = -(pts.ey - pts.sy), ny = pts.ex - pts.sx;
        var len = Math.sqrt(nx * nx + ny * ny) || 1;
        // 根据形状生成采样点
        var samples = [];
        if (shape === 'straight') {
            for (var t = 0; t <= 1; t += 0.02) {
                samples.push({ x: pts.sx + (pts.ex - pts.sx) * t, y: pts.sy + (pts.ey - pts.sy) * t });
            }
        } else if (shape === 'elbow') {
            var midX, midY;
            if (Math.abs(pts.ex - pts.sx) > Math.abs(pts.ey - pts.sy)) { midX = pts.ex; midY = pts.sy; }
            else { midX = pts.sx; midY = pts.ey; }
            for (var t1 = 0; t1 <= 1; t1 += 0.02) {
                samples.push({ x: pts.sx + (midX - pts.sx) * t1, y: pts.sy + (midY - pts.sy) * t1 });
                samples.push({ x: midX + (pts.ex - midX) * t1, y: midY + (pts.ey - midY) * t1 });
            }
        } else {
            var bend = len * bendRatio;
            var cx = mx + (nx / len) * bend, cy = my + (ny / len) * bend;
            for (var t2 = 0; t2 <= 1; t2 += 0.02) {
                var x = (1 - t2) * (1 - t2) * pts.sx + 2 * (1 - t2) * t2 * cx + t2 * t2 * pts.ex;
                var y = (1 - t2) * (1 - t2) * pts.sy + 2 * (1 - t2) * t2 * cy + t2 * t2 * pts.ey;
                samples.push({ x: x, y: y });
            }
        }
        for (var i = 0; i < samples.length; i++) {
            if (Math.hypot(px - samples[i].x, py - samples[i].y) < threshold) return true;
        }
        return false;
    }

    function showEdgePanel(x, y, edge) {
        edgePanelEl.classList.remove('hidden');
        // 恢复流程连线专属控件（树形连线面板会隐藏它们）
        document.getElementById('edge-panel-type').style.display = '';
        document.getElementById('edge-panel-shape').style.display = '';
        document.querySelector('.edge-bend-label').style.display = '';
        document.getElementById('edge-panel-type').value = edge.type === 'loop' ? 'loop' : edge.type;
        document.getElementById('edge-panel-shape').value = edge.shape || 'curve';
        document.getElementById('edge-panel-bend').value = edge.bend != null ? edge.bend : 15;
        document.getElementById('edge-panel-color').value = edge.color || '#c0392b';
        var mw = edgePanelEl.offsetWidth;
        edgePanelEl.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
        edgePanelEl.style.top = (y + 10) + 'px';
    }

    function hideEdgePanel() {
        edgePanelEl.classList.add('hidden');
    }

    /* ------ 树形连线（父子连线）选中与编辑 ------ */

    /** 命中检测树形连线：遍历所有非根节点，检查点是否落在 父->子 贝塞尔连线上 */
    function hitTestTreeLink(px, py) {
        var threshold = 12;
        var data = jm.get_data('node_tree');
        var hit = null;
        (function walk(n) {
            if (hit) return;
            var node = jm.get_node(n.id);
            if (node && !node.isroot && node.parent) {
                // 跳过隐藏节点
                var el = node._data.view.element;
                if (el && el.style.display !== 'none' && el.getBoundingClientRect().width > 0) {
                    var a = getNodeCenter(node.parent.id);
                    var b = getNodeCenter(node.id);
                    if (a && b && pointOnTreeBezier(px, py, a, b, threshold)) {
                        hit = { parentId: node.parent.id, childId: node.id };
                        return;
                    }
                }
            }
            (n.children || []).forEach(walk);
        })(data.data);
        return hit;
    }

    /** 点是否在 父->子 贝塞尔连线上（与 drawParentChildLink 同一曲线参数） */
    function pointOnTreeBezier(px, py, a, b, threshold) {
        var dir = b.x >= a.x ? 1 : -1;
        var sx = a.x + dir * a.w / 2;
        var ex = b.x - dir * b.w / 2;
        // 采样贝塞尔曲线
        for (var t = 0; t <= 1; t += 0.02) {
            var mt = 1 - t;
            var x = mt*mt*mt*sx + 3*mt*mt*t*(sx+30*dir) + 3*mt*t*t*(ex-30*dir) + t*t*t*ex;
            var y = mt*mt*mt*a.y + 3*mt*mt*t*a.y + 3*mt*t*t*b.y + t*t*t*b.y;
            if (Math.hypot(px - x, py - y) < threshold) return true;
        }
        return false;
    }

    /** 显示树形连线编辑面板（仅颜色 + 删除，无类型/形状） */
    function showTreeLinkPanel(x, y, link) {
        edgePanelEl.classList.remove('hidden');
        // 隐藏流程连线专属控件
        document.getElementById('edge-panel-type').style.display = 'none';
        document.getElementById('edge-panel-shape').style.display = 'none';
        document.querySelector('.edge-bend-label').style.display = 'none';
        var node = jm.get_node(link.childId);
        document.getElementById('edge-panel-color').value = (node && node.data['leading-line-color']) || '#555555';
        var mw = edgePanelEl.offsetWidth;
        edgePanelEl.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
        edgePanelEl.style.top = (y + 10) + 'px';
    }

    /** 更新选中树形连线颜色（写入子节点 leading-line-color，jsMind 原生字段随序列化保存） */
    function updateSelectedTreeLinkColor(color) {
        if (!selectedTreeLink) return;
        var node = jm.get_node(selectedTreeLink.childId);
        if (!node) return;
        node.data['leading-line-color'] = color;
        autoSave();
        jm.view.show_lines();
        redrawFlowEdges();
    }

    /** 删除选中树形连线：把子节点转为独立节点（脱离父节点，成为自由节点） */
    function deleteSelectedTreeLink() {
        if (!selectedTreeLink) return;
        var childNode = jm.get_node(selectedTreeLink.childId);
        if (!childNode) return;
        // 转为独立节点：floating + 当前位置为 free 坐标
        var el = childNode._data.view.element;
        var x = el ? parseFloat(el.style.left) : 0;
        var y = el ? parseFloat(el.style.top) : 0;
        applyNodeData(selectedTreeLink.childId, function (n) {
            n.floating = true;
            n['free-x'] = Math.round(x);
            n['free-y'] = Math.round(y);
            delete n['offset-x'];
            delete n['offset-y'];
        });
        selectedTreeLink = null;
        hideEdgePanel();
        redrawFlowEdges();
        showStatus('已断开连接，节点转为独立节点');
    }

    function updateSelectedEdge(mutator) {
        var edges = getFlowEdges().slice();
        var idx = edges.findIndex(function (e) { return e.id === selectedEdgeId; });
        if (idx < 0) return;
        mutator(edges[idx]);
        saveFlowEdges(edges);
        redrawFlowEdges();
    }

    function deleteSelectedEdge() {
        // 优先处理树形连线删除
        if (selectedTreeLink) {
            deleteSelectedTreeLink();
            return;
        }
        saveFlowEdges(getFlowEdges().filter(function (e) { return e.id !== selectedEdgeId; }));
        selectedEdgeId = null;
        hideEdgePanel();
        redrawFlowEdges();
        showStatus('已删除连线');
    }

    function setMode(mode) {
        interactionMode = mode;
        edgeSourceId = null;
        containerEl.classList.toggle('edge-mode', mode === 'edge');
        document.getElementById('btn-mode-select').classList.toggle('active', mode === 'select');
        document.getElementById('btn-mode-edge').classList.toggle('active', mode === 'edge');
        clearEdgeSourceHighlight();
        if (mode === 'edge') {
            showStatus('连线模式：点击源节点，再点击目标节点');
        }
    }

    function clearEdgeSourceHighlight() {
        containerEl.querySelectorAll('jmnode.edge-source').forEach(function (el) {
            el.classList.remove('edge-source');
        });
    }

    /**
     * 点击式连线：第一次点击选源节点，第二次点击选目标节点完成连接。
     * 若已通过右键「连接到」预选源节点（edgeSourceId 已存在），则本次点击直接作为目标。
     */
    function onEdgeModeNodeClick(nodeid) {
        if (suppressEdgeClick) return; // 拖拽连线后的 click，忽略
        var type = document.getElementById('edge-type').value;
        if (!edgeSourceId) {
            edgeSourceId = nodeid;
            var el = containerEl.querySelector('jmnode[nodeid="' + nodeid + '"]');
            if (el) el.classList.add('edge-source');
            showStatus('已选源节点，点击目标节点完成连接');
            return;
        }
        // 源和目标相同视为自环，否则按所选类型连线
        addFlowEdge(edgeSourceId, nodeid, type);
        edgeSourceId = null;
        clearEdgeSourceHighlight();
        setMode('select');
    }

    function addFlowEdge(from, to, type) {
        var edges = getFlowEdges().slice();
        var isLoop = type === 'loop' || from === to;
        var dup = edges.some(function (e) {
            return e.from === from && e.to === to && (e.type === type || (isLoop && e.type === 'loop'));
        });
        if (dup) {
            showStatus('该连线已存在');
            return;
        }
        edges.push({
            id: jsMind.util.uuid.newid(),
            from: from,
            to: to,
            type: isLoop ? 'loop' : type,
            color: '#c0396b',
        });
        saveFlowEdges(edges);
        redrawFlowEdges();
        showStatus('已添加连线');
    }

    function addJunctionNode() {
        // 接头节点改为独立节点（可自由拖动，作为连线的中间节点）
        var nodeid = jsMind.util.uuid.newid();
        jm.add_node('root', nodeid, '');
        // 初始位置：可视区域中心，避让选中节点
        var panel = jm.view.e_panel;
        var cx = panel.scrollLeft + panel.clientWidth / 2;
        var cy = panel.scrollTop + panel.clientHeight / 2;
        applyNodeData(nodeid, function (n) {
            n['custom-shape'] = 'circle';
            n.junction = true;
            n.floating = true;
            n['free-x'] = Math.round(cx - 11);
            n['free-y'] = Math.round(cy - 11);
            n.width = 22;
            n.height = 22;
            n['background-color'] = '#ffffff';
        });
        jm.select_node(nodeid);
        showStatus('已添加接头节点，可拖动作为连线中间点');
    }

    /* ------ 独立节点（自由拖动） ------ */

    /**
     * 添加独立节点：挂在根节点下但通过 free-x/free-y 记录自由位置，
     * 不参与树形布局，可自由拖动，用流程连线与其他节点连接。
     */
    function addFloatingNode() {
        var nodeid = jsMind.util.uuid.newid();
        jm.add_node('root', nodeid, '独立节点');
        // 计算可视区域中心（内容坐标），并避让当前选中节点，防止重叠
        var panel = jm.view.e_panel;
        var viewCenterX = panel.scrollLeft + panel.clientWidth / 2;
        var viewCenterY = panel.scrollTop + panel.clientHeight / 2;
        var nodeW = 86, nodeH = 40;
        var fx = viewCenterX - nodeW / 2;
        var fy = viewCenterY - nodeH / 2;
        // 若与选中节点重叠，偏移到其下方；未选中节点时避让根节点（默认在其右侧）
        var sel = jm.get_selected_node();
        var anchor = sel || jm.get_node('root');
        if (anchor) {
            var aEl = anchor._data.view.element;
            if (aEl) {
                var sx = parseFloat(aEl.style.left) || 0;
                var sy = parseFloat(aEl.style.top) || 0;
                var sw = aEl.offsetWidth, sh = aEl.offsetHeight;
                var overlap = !(fx > sx + sw || fx + nodeW < sx || fy > sy + sh || fy + nodeH < sy);
                if (overlap) {
                    // 默认移到锚点右侧，避免遮挡
                    fx = sx + sw + 60;
                    fy = sy + sh / 2 - nodeH / 2;
                }
            }
        }
        applyNodeData(nodeid, function (n) {
            n['floating'] = true;
            n['free-x'] = Math.round(fx);
            n['free-y'] = Math.round(fy);
            n['background-color'] = '#fef9e7';
        });
        jm.select_node(nodeid);
        showStatus('已添加独立节点，可拖动到任意位置');
    }

    /** 应用独立节点的自由位置与拖动 */
    var floatingDragEndTime = 0;
    function applyFloatingNodes() {
        // 拖动过程中或刚结束时（50ms 内）不重新应用，避免覆盖刚拖动的位置
        if (floatingDrag || Date.now() - floatingDragEndTime < 50) return;
        var data = jm.get_data('node_tree');
        (function walk(n) {
            if (n.floating) {
                var el = containerEl.querySelector('jmnode[nodeid="' + n.id + '"]');
                // 从运行时节点 data 读取最新 free-x/free-y（get_data 序列化可能滞后）
                var runtimeNode = jm.get_node(n.id);
                if (el && runtimeNode) {
                    // 保持节点在布局中可见（不影响 jsMind 选择/删除），
                    // 仅覆盖其位置到自由坐标；树形连线由 custom_line_render 跳过。
                    var fx = runtimeNode.data['free-x'] != null ? runtimeNode.data['free-x'] : (n['free-x'] != null ? n['free-x'] : 0);
                    var fy = runtimeNode.data['free-y'] != null ? runtimeNode.data['free-y'] : (n['free-y'] != null ? n['free-y'] : 0);
                    el.style.left = fx + 'px';
                    el.style.top = fy + 'px';
                    el.classList.add('floating-node');
                    // 子树：以独立节点为锚点做局部布局，跟随其位置
                    layoutFloatingChildren(n, el, fx, fy);
                    // 修正子树的 expander 位置（按实际节点位置）
                    fixFloatingExpanders(n);
                }
            }
            (n.children || []).forEach(walk);
        })(data.data);
        redrawFlowEdges();
    }

    /**
     * 布局独立节点的子节点：相对独立节点水平向右依次排列，垂直堆叠居中。
     * 子节点记录相对独立节点的偏移（rel-x/rel-y），首次布局时计算，之后跟随。
     */
    function layoutFloatingChildren(treeNode, parentEl, parentX, parentY) {
        var children = treeNode.children || [];
        if (!children.length) return;
        // 父节点收起时，隐藏所有子孙节点并不布局（jsMind 默认只控制 display，
        // 独立节点子树位置被我们覆盖，需主动隐藏防止偏出画布）
        if (treeNode.expanded === false) {
            hideFloatingDescendants(treeNode);
            return;
        }
        var parentW = parentEl.offsetWidth, parentH = parentEl.offsetHeight;
        var gapX = 50, gapY = 16;
        // 先测量子节点尺寸
        var childInfos = children.map(function (c) {
            var el = containerEl.querySelector('jmnode[nodeid="' + c.id + '"]');
            return { node: c, el: el, w: el ? el.offsetWidth : 80, h: el ? el.offsetHeight : 38 };
        });
        var totalH = childInfos.reduce(function (s, c) { return s + c.h; }, 0) + gapY * (childInfos.length - 1);
        var startY = parentY + parentH / 2 - totalH / 2;
        var x = parentX + parentW + gapX;
        childInfos.forEach(function (info, i) {
            if (!info.el) return;
            // 若已记录相对偏移则用之（用户可能拖过子节点），否则按序布局
            var relX = info.node['rel-x'];
            var relY = info.node['rel-y'];
            var cx, cy;
            if (relX != null && relY != null) {
                cx = parentX + relX;
                cy = parentY + relY;
            } else {
                cx = x;
                cy = startY;
                startY += info.h + gapY;
                // 记录相对偏移（写入运行时 data，随序列化保存）
                var node = jm.get_node(info.node.id);
                if (node) {
                    node.data['rel-x'] = cx - parentX;
                    node.data['rel-y'] = cy - parentY;
                }
            }
            info.el.style.left = cx + 'px';
            info.el.style.top = cy + 'px';
            // 子树节点也标记为可自由拖动（floating-node），拖动时更新 rel 偏移而非改父级
            info.el.classList.add('floating-node', 'floating-child');
            // 递归布局其子节点
            layoutFloatingChildren(info.node, info.el, cx, cy);
        });
    }

    /**
     * 修正独立节点子树中所有 expander（展开/收起点）的位置。
     * jsMind 按布局坐标定位 expander，独立节点位置被覆盖后 expander 会偏离，
     * 这里按节点实际位置（style.left/top）重新定位到节点右缘中点。
     */
    function fixFloatingExpanders(treeNode) {
        (function walk(n) {
            var node = jm.get_node(n.id);
            if (node && node._data.view.expander) {
                var el = node._data.view.element;
                var expander = node._data.view.expander;
                if (el && (n.children || []).length > 0) {
                    var nx = parseFloat(el.style.left) || 0;
                    var ny = parseFloat(el.style.top) || 0;
                    var nw = el.offsetWidth, nh = el.offsetHeight;
                    // 根据节点方向定位 expander：左侧节点放左缘，右侧节点放右缘
                    var dir = node._data.layout.direction; // -1=左, 1=右
                    if (dir === -1) {
                        expander.style.left = (nx - 4 - expander.offsetWidth) + 'px';
                    } else {
                        expander.style.left = (nx + nw + 4) + 'px';
                    }
                    expander.style.top = (ny + nh / 2 - expander.offsetHeight / 2) + 'px';
                }
            }
            (n.children || []).forEach(walk);
        })(treeNode);
    }

    /** 拖动独立节点时，按其当前位置重布局子树（子节点相对偏移不变，跟随移动） */
    function moveFloatingSubtree(nodeid, parentEl, parentX, parentY) {
        var node = jm.get_node(nodeid);
        if (!node) return;
        var treeNode = findTreeNode(jm.get_data('node_tree').data, nodeid);
        if (!treeNode) return;
        layoutFloatingChildren(treeNode, parentEl, parentX, parentY);
        // 拖动后同步修正 expander 位置
        fixFloatingExpanders(treeNode);
    }

    /** 树节点自由拖动：子树所有节点按相同偏移跟随移动（基于拖动起始位置）。
        只改元素 style（视觉），不写 layout.offset（保持纯净）；树形连线由 flow 层按
        元素实际位置重画（drawOffsetSubtreeLines），故拖动中实时跟随且重排后不错位。 */
    function moveTreeSubtree(nodeid, dx, dy) {
        if (!floatingDrag || !floatingDrag.subtreeStart) return;
        floatingDrag.subtreeStart.forEach(function (item) {
            var el = containerEl.querySelector('jmnode[nodeid="' + item.id + '"]');
            if (el) {
                el.style.left = (item.x + dx) + 'px';
                el.style.top = (item.y + dy) + 'px';
            }
        });
        // 重画 jsMind 树形连线（被拖子树被 draw_line 拦截，由 flow 层按元素位置画）
        if (jm.layout) {
            jm.layout.cache_valid = false;
            jm.view.show_lines();
        }
        // 树形连线由 flow 层基于元素位置绘制，拖动中实时重画
        redrawFlowEdges();
        var treeNode = findTreeNode(jm.get_data('node_tree').data, nodeid);
        if (treeNode) fixFloatingExpanders(treeNode);
    }

    /** 捕获树节点子树所有节点的当前位置（拖动开始时记录）。
        独立节点（floating）是自由体系，不随树拖动，跳过。 */
    function captureSubtreePositions(nodeid) {
        var treeNode = findTreeNode(jm.get_data('node_tree').data, nodeid);
        if (!treeNode) return null;
        var positions = [];
        (function walk(n) {
            // 独立节点不随树子树拖动
            if (n.floating) return;
            var el = containerEl.querySelector('jmnode[nodeid="' + n.id + '"]');
            if (el) {
                positions.push({
                    id: n.id,
                    x: parseFloat(el.style.left) || 0,
                    y: parseFloat(el.style.top) || 0,
                });
            }
            (n.children || []).forEach(walk);
        })(treeNode);
        return positions;
    }

    /**
     * 重设树节点的自由偏移位置（全量绝对定位，天然幂等）。
     *
     * 设计：data.offset-x/y 是唯一持久化的位置修正，layout.offset 永不被修改
     * （保持为 jsMind 的纯净布局基准），因此无论 layout() 完整重排还是 part_layout
     * 局部重排（expander 收起/展开），布局基准始终纯净可预期。
     *
     * 元素位置 = view_offset + get_node_point(纯净布局) + 继承偏移。
     * get_node_point 基于 layout.offset（纯净），view_offset 基于布局 bounds，
     * 二者在每次重排后由 jsMind 重算，天然反映最新布局基准，故重设后位置始终正确。
     *
     * 树形连线：jsMind 原生 show_lines 用 layout.offset（纯净）画在基准位置，与有偏移
     * 的节点脱节，故对有偏移的子树，draw_line 拦截跳过，改由 flow 层基于元素实际
     * 位置绘制（见 drawOffsetSubtreeLines），保证连线贴合节点。
     */
    function applyTreeOffsets() {
        if (isRestoringSnapshot) return; // 恢复快照时已包含偏移，避免二次叠加
        var vo = jm.view.get_view_offset();
        var data = jm.get_data('node_tree');
        var changed = false;
        (function walk(n, inheritedOx, inheritedOy) {
            var node = jm.get_node(n.id);
            // 独立节点（floating）及其子树是自由体系，不应用树偏移继承，直接跳过
            if (node && node.data && node.data.floating) return;
            var ox = inheritedOx, oy = inheritedOy;
            if (node && (node.data['offset-x'] || node.data['offset-y'])) {
                ox += node.data['offset-x'] || 0;
                oy += node.data['offset-y'] || 0;
            }
            if ((ox !== 0 || oy !== 0) && node) {
                var el = containerEl.querySelector('jmnode[nodeid="' + n.id + '"]');
                if (el) {
                    // 纯净布局位置（layout.offset 未被污染，get_node_point 即基准左上角点）
                    var pt = jm.layout.get_node_point(node);
                    // get_node_point 返回的是节点中心相关点（随方向），换算回左上角：
                    // show_nodes 中 style.left = view_offset.x + point.x，point 由
                    // get_node_point 给出且与元素左上角对齐（jsMind 内部已处理方向）。
                    var baseX = vo.x + pt.x;
                    var baseY = vo.y + pt.y;
                    el.style.left = (baseX + ox) + 'px';
                    el.style.top = (baseY + oy) + 'px';
                    changed = true;
                }
            }
            (n.children || []).forEach(function (c) { walk(c, ox, oy); });
        })(data.data, 0, 0);
        // 修正有偏移子树的 expander 位置（jsMind 按纯净布局定位 expander，需跟随实际元素）
        if (changed) {
            (function fixWalk(n, insideOffset) {
                var node = jm.get_node(n.id);
                var isAnchor = node && node.data && (node.data['offset-x'] || node.data['offset-y']);
                var nowInside = insideOffset || isAnchor;
                if (nowInside) {
                    var treeNode = findTreeNode(data.data, n.id);
                    if (treeNode) fixFloatingExpanders(treeNode);
                }
                (n.children || []).forEach(function (c) { if (!nowInside) fixWalk(c, false); });
            })(data.data, false);
        }
        // 树形连线：有偏移子树由 flow 层按元素位置重画（drawOffsetSubtreeLines），
        // jsMind 原生 show_lines 仍会画（画在基准位置），需要拦截跳过这些节点。
        if (changed) {
            redrawFlowEdges();
        }
    }

    /** 隐藏独立节点的所有子孙节点（收起时调用） */
    function hideFloatingDescendants(treeNode) {
        (treeNode.children || []).forEach(function (child) {
            var el = containerEl.querySelector('jmnode[nodeid="' + child.id + '"]');
            if (el) el.style.display = 'none';
            var node = jm.get_node(child.id);
            if (node && node._data.view.expander) node._data.view.expander.style.display = 'none';
            hideFloatingDescendants(child);
        });
    }

    /* ------ 节点自由拖动（独立节点 + 主节点子树） ------ */

    var floatingDrag = null;
    function bindFloatingDrag() {
        containerEl.addEventListener('mousedown', function (e) {
            if (interactionMode === 'edge') return;
            var nodeEl = e.target.closest('jmnode');
            if (!nodeEl) return;
            var nodeid = nodeEl.getAttribute('nodeid');
            var node = jm.get_node(nodeid);
            if (!node) return;
            // 先让 jsMind 正常选中该节点（否则删除/编辑会作用于错误的节点）
            jm.select_node(nodeid);
            var isFloatingChild = nodeEl.classList.contains('floating-child');
            var isFloatingRoot = nodeEl.classList.contains('floating-node') && !isFloatingChild;
            // 主节点（普通树节点）：按住 Alt 键拖动为自由移动子树；否则交给 jsMind 插件调整层级
            var isTreeNode = !isFloatingRoot && !isFloatingChild;
            if (isTreeNode && !e.altKey) return; // 普通拖动：交给 jsMind draggable 插件
            floatingDrag = {
                id: nodeid,
                el: nodeEl,
                isChild: isFloatingChild,
                isTree: isTreeNode,
                parentId: isFloatingChild && node.parent ? node.parent.id : null,
                startX: e.clientX,
                startY: e.clientY,
                origX: parseFloat(nodeEl.style.left) || 0,
                origY: parseFloat(nodeEl.style.top) || 0,
                // 树节点：记录子树所有节点的起始位置
                subtreeStart: isTreeNode ? captureSubtreePositions(nodeid) : null,
                moved: false,
            };
            // 标记正在拖动的子树（供 draw_line/drawOffsetSubtreeLines 识别，实时重画连线）
            if (isTreeNode && floatingDrag.subtreeStart) {
                activeDragIds = {};
                floatingDrag.subtreeStart.forEach(function (it) { activeDragIds[it.id] = true; });
            }
            // 阻止 jsMind 的 view 拖拽接管
            e.preventDefault();
            e.stopPropagation();
        }, true);

        document.addEventListener('mousemove', function (e) {
            if (!floatingDrag) return;
            if (regionDrag) { floatingDrag = null; return; } // 组拖动优先，避免双重移动
            floatingDrag.moved = true;
            var dx = e.clientX - floatingDrag.startX;
            var dy = e.clientY - floatingDrag.startY;
            var nx = floatingDrag.origX + dx;
            var ny = floatingDrag.origY + dy;
            floatingDrag.el.style.left = nx + 'px';
            floatingDrag.el.style.top = ny + 'px';
            if (floatingDrag.isChild) {
                // 子节点只动自身
            } else if (floatingDrag.isTree) {
                // 树节点：整个子树按相同偏移跟随
                moveTreeSubtree(floatingDrag.id, dx, dy);
            } else {
                // 根独立节点：子树跟随
                moveFloatingSubtree(floatingDrag.id, floatingDrag.el, nx, ny);
            }
            redrawFlowEdges();
        });

        document.addEventListener('mouseup', function () {
            if (!floatingDrag) return;
            if (floatingDrag.moved) {
                // 直接写入节点运行时 data 并自动保存，不做完整重建（避免位置被重置）
                var x = parseFloat(floatingDrag.el.style.left);
                var y = parseFloat(floatingDrag.el.style.top);
                var node = jm.get_node(floatingDrag.id);
                var dragId = floatingDrag.id;
                var isChild = floatingDrag.isChild;
                var parentId = floatingDrag.parentId;
                var isTree = floatingDrag.isTree;
                var origX = floatingDrag.origX;
                var origY = floatingDrag.origY;
                floatingDrag = null;
                activeDragIds = null; // 拖动结束，清除标记
                floatingDragEndTime = Date.now(); // 标记拖动结束时间，防止重应用覆盖
                if (node) {
                    if (isChild && parentId) {
                        // 子节点：更新相对父节点的偏移，保持原始连接关系不变
                        var parentNode = jm.get_node(parentId);
                        if (parentNode && parentNode._data.view.element) {
                            var px = parseFloat(parentNode._data.view.element.style.left) || 0;
                            var py = parseFloat(parentNode._data.view.element.style.top) || 0;
                            node.data['rel-x'] = Math.round(x - px);
                            node.data['rel-y'] = Math.round(y - py);
                        }
                    } else if (isTree) {
                        // 树节点：记录累计偏移（原有偏移 + 本次拖动）
                        var dxTotal = (node.data['offset-x'] || 0) + (x - origX);
                        var dyTotal = (node.data['offset-y'] || 0) + (y - origY);
                        node.data['offset-x'] = Math.round(dxTotal);
                        node.data['offset-y'] = Math.round(dyTotal);
                    } else {
                        node.data['free-x'] = Math.round(x);
                        node.data['free-y'] = Math.round(y);
                        // 拖动结束后保证子树位置与最终位置一致
                        moveFloatingSubtree(dragId, node._data.view.element, x, y);
                    }
                    autoSave();
                    showStatus(isChild ? '已移动子节点' : '已移动节点');
                }
            } else {
                floatingDrag = null;
                activeDragIds = null;
            }
        });
    }

    /* ------ 区域框选与整体拖动（Ctrl/Alt + 左键划过区域） ------ */

    var marqueeEl = null;             // 框选矩形 DOM
    var marquee = null;               // 框选状态 {startX, startY}
    var regionSelection = null;       // 当前区域选择 {nodeIds:[], edgeIds:[]}
    var regionDrag = null;            // 组拖动状态 {nodeIds:[], edgeIds:[], startX, startY, moved, nodeStarts:{}, touchRoots:[], floatingRoots:{}}
    var justFinishedRegion = false;   // 刚结束框选/组拖动，抑制 click 清空选择

    function ensureMarqueeEl() {
        if (marqueeEl) return marqueeEl;
        marqueeEl = document.createElement('div');
        marqueeEl.className = 'region-marquee hidden';
        containerEl.appendChild(marqueeEl);
        return marqueeEl;
    }

    /** 框选矩形（client 坐标）规范化 */
    function normalizeRect(x1, y1, x2, y2) {
        return { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
    }

    function rectsIntersect(r1, r2) {
        return !(r2.left > r1.right || r2.right < r1.left || r2.top > r1.bottom || r2.bottom < r1.top);
    }

    /** 选中框选区域内的所有节点与流程连线 */
    function selectRegion(x1, y1, x2, y2) {
        var r = normalizeRect(x1, y1, x2, y2);
        var rect = { left: r.x1, top: r.y1, right: r.x2, bottom: r.y2 };
        var nodeIds = [];
        containerEl.querySelectorAll('jmnode[nodeid]').forEach(function (el) {
            if (el.style.display === 'none') return;
            if (rectsIntersect(rect, el.getBoundingClientRect())) {
                nodeIds.push(el.getAttribute('nodeid'));
            }
        });
        var edgeIds = [];
        var cr = flowCanvas.getBoundingClientRect();
        getFlowEdges().forEach(function (e) {
            if (edgeIntersectsRect(e, rect, cr)) edgeIds.push(e.id);
        });
        regionSelection = nodeIds.length || edgeIds.length ? { nodeIds: nodeIds, edgeIds: edgeIds } : null;
        updateRegionHighlight();
        return regionSelection;
    }

    /** 判断流程连线是否穿过给定 client 矩形区域 */
    function edgeIntersectsRect(edge, rect, cr) {
        // 复用 isPointOnEdge 的采样方式：沿连线采样点落在矩形内即视为相交
        var pts = edgePoints(edge.from, edge.to);
        if (!pts) return false;
        if (edge.type === 'loop' || edge.from === edge.to) {
            var c = getNodeCenter(edge.from);
            var r0 = Math.max(c.w, c.h) / 2 + 18;
            for (var a = 0; a < Math.PI * 2; a += 0.15) {
                var lx = c.x + r0 * Math.cos(a), ly = c.y + r0 * Math.sin(a);
                var cx = cr.left + lx, cy = cr.top + ly;
                if (cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom) return true;
            }
            return false;
        }
        var shape = edge.shape || 'curve';
        var bendRatio = (edge.bend != null ? edge.bend : 15) / 100;
        var mx = (pts.sx + pts.ex) / 2, my = (pts.sy + pts.ey) / 2;
        var nx = -(pts.ey - pts.sy), ny = pts.ex - pts.sx;
        var len = Math.sqrt(nx * nx + ny * ny) || 1;
        var samples = [];
        if (shape === 'straight') {
            for (var t = 0; t <= 1; t += 0.03) samples.push({ x: pts.sx + (pts.ex - pts.sx) * t, y: pts.sy + (pts.ey - pts.sy) * t });
        } else if (shape === 'elbow') {
            var midX, midY;
            if (Math.abs(pts.ex - pts.sx) > Math.abs(pts.ey - pts.sy)) { midX = pts.ex; midY = pts.sy; }
            else { midX = pts.sx; midY = pts.ey; }
            for (var t1 = 0; t1 <= 1; t1 += 0.03) {
                samples.push({ x: pts.sx + (midX - pts.sx) * t1, y: pts.sy + (midY - pts.sy) * t1 });
                samples.push({ x: midX + (pts.ex - midX) * t1, y: midY + (pts.ey - midY) * t1 });
            }
        } else {
            var bend = len * bendRatio;
            var cx2 = mx + (nx / len) * bend, cy2 = my + (ny / len) * bend;
            for (var t2 = 0; t2 <= 1; t2 += 0.03) {
                samples.push({
                    x: (1 - t2) * (1 - t2) * pts.sx + 2 * (1 - t2) * t2 * cx2 + t2 * t2 * pts.ex,
                    y: (1 - t2) * (1 - t2) * pts.sy + 2 * (1 - t2) * t2 * cy2 + t2 * t2 * pts.ey,
                });
            }
        }
        for (var i = 0; i < samples.length; i++) {
            var cx = cr.left + samples[i].x, cy = cr.top + samples[i].y;
            if (cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom) return true;
        }
        return false;
    }

    function updateRegionHighlight() {
        containerEl.querySelectorAll('jmnode.region-selected').forEach(function (el) { el.classList.remove('region-selected'); });
        if (!regionSelection) { redrawFlowEdges(); return; }
        regionSelection.nodeIds.forEach(function (id) {
            var el = containerEl.querySelector('jmnode[nodeid="' + id + '"]');
            if (el) el.classList.add('region-selected');
        });
        redrawFlowEdges();
    }

    function clearRegionSelection() {
        regionSelection = null;
        updateRegionHighlight();
    }

    /** 找到节点在“自由移动链”上的锚点：树节点/独立根本身即锚点，floating-child 向上找到其根 */
    function topFreeAncestor(nodeid) {
        var node = jm.get_node(nodeid);
        if (!node) return null;
        var cur = node;
        while (cur) {
            var el = cur._data && cur._data.view && cur._data.view.element;
            if (!el) return cur;
            var isChild = el.classList.contains('floating-child');
            if (!isChild) return cur; // 树节点或独立根：自身即移动锚点
            cur = cur.parent; // floating-child：向上找独立根
        }
        return cur;
    }

    function bindRegionSelect() {
        ensureMarqueeEl();
        // mousedown（window 捕获层）：区分框选 / 组拖动 / 普通。
        // 用 window 而非 containerEl，避免节点被左右面板遮挡时事件被面板拦截。
        window.addEventListener('mousedown', function (e) {
            if (interactionMode === 'edge') return;
            if (e.button !== 0) return;
            if (!containerEl.contains(e.target)) return; // 只处理画布内的按下
            // Ctrl/Alt + 左键：开始框选（无论点在空白还是节点上）
            if (e.ctrlKey || e.altKey || e.metaKey) {
                var nodeEl = e.target.closest('jmnode');
                // Alt + 点在节点上：让给 floatingDrag 做 Alt 自由移动（单节点子树），
                // 不启动框选，也不拦截事件（floatingDrag 在 container capture 处理）。
                if (e.altKey && !e.ctrlKey && !e.metaKey && nodeEl) return;
                // 若已有区域选择且点中选中节点，则进入组拖动
                if (nodeEl && regionSelection && regionSelection.nodeIds.indexOf(nodeEl.getAttribute('nodeid')) >= 0) {
                    startRegionDrag(e);
                    return;
                }
                // 空白或节点上：开始框选
                marquee = { startX: e.clientX, startY: e.clientY };
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            // 无修饰键：若点中区域选择内的节点，也允许组拖动（更友好的交互）
            var nodeEl2 = e.target.closest('jmnode');
            if (nodeEl2 && regionSelection && regionSelection.nodeIds.indexOf(nodeEl2.getAttribute('nodeid')) >= 0) {
                startRegionDrag(e);
            }
        }, true);

        document.addEventListener('mousemove', function (e) {
            // 框选进行中：更新矩形
            if (marquee) {
                var r = normalizeRect(marquee.startX, marquee.startY, e.clientX, e.clientY);
                var m = ensureMarqueeEl();
                m.classList.remove('hidden');
                m.style.left = r.x1 + 'px';
                m.style.top = r.y1 + 'px';
                m.style.width = (r.x2 - r.x1) + 'px';
                m.style.height = (r.y2 - r.y1) + 'px';
                return;
            }
            // 组拖动进行中
            if (regionDrag) {
                var dx = e.clientX - regionDrag.startX;
                var dy = e.clientY - regionDrag.startY;
                if (Math.abs(dx) > 2 || Math.abs(dy) > 2) regionDrag.moved = true;
                regionDrag.lastDx = dx;
                regionDrag.lastDy = dy;
                moveRegionBy(dx, dy);
                return;
            }
        });

        document.addEventListener('mouseup', function (e) {
            // 结束框选
            if (marquee) {
                var r = normalizeRect(marquee.startX, marquee.startY, e.clientX, e.clientY);
                var m = ensureMarqueeEl();
                m.classList.add('hidden');
                var wasMarquee = marquee;
                marquee = null;
                if (r.x2 - r.x1 > 4 && r.y2 - r.y1 > 4) {
                    selectRegion(r.x1, r.y1, r.x2, r.y2);
                } else {
                    clearRegionSelection();
                }
                justFinishedRegion = true;
                setTimeout(function () { justFinishedRegion = false; }, 50);
                return;
            }
            // 结束组拖动
            if (regionDrag) {
                finishRegionDrag();
                justFinishedRegion = true;
                setTimeout(function () { justFinishedRegion = false; }, 50);
                return;
            }
        });

        // Esc 清除区域选择；点击空白清除
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && regionSelection) clearRegionSelection();
        });
        containerEl.addEventListener('click', function (e) {
            if (justFinishedRegion) return;
            if (!regionSelection) return;
            if (e.target.closest('jmnode')) return;
            clearRegionSelection();
        }, true);
    }

    /** 从一组锚点 id 中筛出“顶层锚点”：没有祖先也在该集合中的节点。
        树形连线按父级累加 offset，只有顶层锚点需要写布局坐标，避免重复累加。 */
    function computeTopRoots(anchorIds) {
        return anchorIds.filter(function (rid) {
            return !anchorIds.some(function (other) {
                if (other === rid) return false;
                var p = jm.get_node(rid);
                while (p && p.parent) { p = p.parent; if (p.id === other) return true; }
                return false;
            });
        });
    }

    /** 开始区域组拖动：记录每个选中节点的起始位置与需要持久化的根 */
    function startRegionDrag(e) {
        var nodeStarts = {};
        var nodeSet = {};
        regionSelection.nodeIds.forEach(function (id) {
            var el = containerEl.querySelector('jmnode[nodeid="' + id + '"]');
            var node = jm.get_node(id);
            if (el && node) {
                nodeStarts[id] = {
                    x: parseFloat(el.style.left) || 0,
                    y: parseFloat(el.style.top) || 0,
                };
                nodeSet[id] = true;
            }
        });
        // 计算需要持久化的“自由移动根”：树节点/独立根的最高祖先
        var touchRoots = [];
        var seen = {};
        regionSelection.nodeIds.forEach(function (id) {
            var top = topFreeAncestor(id);
            if (top && !seen[top.id]) { seen[top.id] = true; touchRoots.push(top.id); }
        });
        regionDrag = {
            nodeIds: regionSelection.nodeIds.slice(),
            edgeIds: regionSelection.edgeIds.slice(),
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            nodeStarts: nodeStarts,
            touchRoots: touchRoots,
            topRoots: computeTopRoots(touchRoots), // 树形连线只更新顶层锚点
        };
        floatingDrag = null; // 组拖动期间禁用单节点拖动，防止竞争
        // 标记正在拖动的节点集合，供 draw_line/drawOffsetSubtreeLines 识别，实时重画连线
        activeDragIds = {};
        regionDrag.nodeIds.forEach(function (id) { activeDragIds[id] = true; });
        e.preventDefault();
        e.stopPropagation();
    }

    /** 组拖动中：所有选中节点按 dx/dy 平移，连线与树形连线实时跟随。
        只改元素 style（视觉），不写 layout.offset（保持纯净）；树形连线由 flow 层按
        元素实际位置重画（drawOffsetSubtreeLines），拖动中实时跟随且重排后不错位。 */
    function moveRegionBy(dx, dy) {
        regionDrag.nodeIds.forEach(function (id) {
            var s = regionDrag.nodeStarts[id];
            if (!s) return;
            var el = containerEl.querySelector('jmnode[nodeid="' + id + '"]');
            if (el) {
                el.style.left = (s.x + dx) + 'px';
                el.style.top = (s.y + dy) + 'px';
            }
        });
        // 修正选中树节点的 expander
        regionDrag.touchRoots.forEach(function (id) {
            var treeNode = findTreeNode(jm.get_data('node_tree').data, id);
            if (treeNode) fixFloatingExpanders(treeNode);
        });
        // 重画 jsMind 树形连线（被拖子树被拦截，flow 层按元素位置画）+ flow 层连线
        if (jm.layout) {
            jm.layout.cache_valid = false;
            jm.view.show_lines();
        }
        redrawFlowEdges();
    }

    /** 结束组拖动：把移动量持久化到各“自由移动根”的偏移字段 */
    function finishRegionDrag() {
        // 用拖动过程中记录的最后位移（比读元素差值更稳健，可能被其它拖拽逻辑重置）
        var dx = regionDrag.lastDx || 0;
        var dy = regionDrag.lastDy || 0;
        var moved = regionDrag.moved;
        var roots = regionDrag.touchRoots;
        var selNodeIds = regionDrag.nodeIds.slice();
        var selEdgeIds = regionDrag.edgeIds.slice();
        regionDrag = null;
        activeDragIds = null; // 拖动结束，清除标记
        if (!moved) return;
        // 只持久化“顶层锚点”：其后代由祖先的偏移继承，不再重复存储，
        // 否则 applyTreeOffsets 刷新时会对后代双重累加。
        var topRoots = computeTopRoots(roots);
        topRoots.forEach(function (rid) {
            var node = jm.get_node(rid);
            if (!node) return;
            var el = node._data.view.element;
            var isTree = !el.classList.contains('floating-node') && !el.classList.contains('floating-child');
            if (isTree) {
                node.data['offset-x'] = Math.round((node.data['offset-x'] || 0) + dx);
                node.data['offset-y'] = Math.round((node.data['offset-y'] || 0) + dy);
            } else {
                node.data['free-x'] = Math.round(parseFloat(el.style.left));
                node.data['free-y'] = Math.round(parseFloat(el.style.top));
            }
        });
        autoSave();
        recordHistory();
        showStatus('已移动选中区域');
        floatingDragEndTime = Date.now(); // 防止位置重应用覆盖
        // 保持区域选择高亮
        regionSelection = { nodeIds: selNodeIds, edgeIds: selEdgeIds };
        updateRegionHighlight();
    }

    /* ------ 鼠标拖拽连线 ------ */

    var dragEdge = null; // { fromId, x, y }
    function bindDragEdge() {
        containerEl.addEventListener('mousedown', function (e) {
            if (interactionMode !== 'edge') return;
            var nodeEl = e.target.closest('jmnode');
            if (!nodeEl) return;
            var nodeid = nodeEl.getAttribute('nodeid');
            if (!nodeid) return;
            // 已预选源节点（右键「连接到」/已点选源）且点击的是不同节点：
            // 交给 click 走点击式（作为目标完成连接），不启动拖拽
            if (edgeSourceId && edgeSourceId !== nodeid) {
                return;
            }
            // 开始可能的拖拽连线；纯点击会在 mouseup 时因未移动而转交 click 处理
            dragEdge = { fromId: nodeid, x: e.clientX, y: e.clientY, moved: false, el: nodeEl };
            e.preventDefault();
        }, true);

        document.addEventListener('mousemove', function (e) {
            if (!dragEdge) return;
            dragEdge.moved = true;
            dragEdge.el.classList.add('edge-source');
            edgeSourceId = dragEdge.fromId;
            var cr = flowCanvas.getBoundingClientRect();
            dragEdge.x = e.clientX - cr.left;
            dragEdge.y = e.clientY - cr.top;
            redrawFlowEdges();
            drawDragPreview();
        });

        document.addEventListener('mouseup', function (e) {
            if (!dragEdge) return;
            var fromId = dragEdge.fromId;
            var moved = dragEdge.moved;
            var el = dragEdge.el;
            dragEdge = null;
            if (!moved) {
                // 纯点击：不在这里处理，交给 click 事件走 onEdgeModeNodeClick（选源/选目标）
                return;
            }
            // 拖拽后松开：用坐标反查目标节点完成连线
            if (el) el.classList.remove('edge-source');
            redrawFlowEdges();
            var toId = findNodeAtPoint(e.clientX, e.clientY);
            if (toId && toId !== fromId) {
                addFlowEdge(fromId, toId, document.getElementById('edge-type').value);
            } else if (toId === fromId) {
                addFlowEdge(fromId, fromId, 'loop');
            }
            // 保持连线模式，支持连续拖拽连接多条；edgeSourceId 清空等待下一次
            edgeSourceId = null;
            clearEdgeSourceHighlight();
            // 抑制拖拽后紧随的 click 事件，避免重复走点击式连线
            suppressEdgeClick = true;
            setTimeout(function () { suppressEdgeClick = false; }, 50);
        });
    }

    /** 拖拽完成后短暂抑制 click，防止重复连线 */
    var suppressEdgeClick = false;

    /** 根据屏幕坐标反查命中的节点 id（用各节点包围盒判断） */
    function findNodeAtPoint(clientX, clientY) {
        var nodes = containerEl.querySelectorAll('jmnode[nodeid]');
        for (var i = 0; i < nodes.length; i++) {
            var r = nodes[i].getBoundingClientRect();
            if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
                return nodes[i].getAttribute('nodeid');
            }
        }
        return null;
    }

    /** 拖拽中的连线预览（虚线） */
    function drawDragPreview() {
        if (!dragEdge || !flowCtx) return;
        var from = getNodeCenter(dragEdge.fromId);
        if (!from) return;
        flowCtx.save();
        flowCtx.strokeStyle = '#e67e22';
        flowCtx.lineWidth = 2;
        flowCtx.setLineDash([5, 4]);
        flowCtx.beginPath();
        flowCtx.moveTo(from.x, from.y);
        flowCtx.lineTo(dragEdge.x, dragEdge.y);
        flowCtx.stroke();
        flowCtx.setLineDash([]);
        flowCtx.restore();
    }

    function addJunctionNode2() { /* 占位避免误删 */ }

    function applyJunctionStyles() {
        var data = jm.get_data('node_tree');
        (function walk(n) {
            if (n.junction) {
                var el = containerEl.querySelector('jmnode[nodeid="' + n.id + '"]');
                if (el) el.classList.add('junction-node');
            }
            (n.children || []).forEach(walk);
        })(data.data);
        applyFloatingNodes();
    }

    function cleanupEdgesForNode(nodeid) {
        var edges = getFlowEdges();
        var remaining = edges.filter(function (e) { return e.from !== nodeid && e.to !== nodeid; });
        if (remaining.length !== edges.length) {
            // 直接写入运行时数据并保存，不触发完整重建（remove_node 已重建过一次）
            var root = jm.get_node('root');
            if (root) {
                if (remaining.length) {
                    root.data['flow-edges'] = remaining;
                } else {
                    delete root.data['flow-edges'];
                }
            }
            if (selectedEdgeId && !remaining.some(function (e) { return e.id === selectedEdgeId; })) {
                selectedEdgeId = null;
                hideEdgePanel();
            }
            redrawFlowEdges();
        }
    }

    function bindFlowEvents() {
        document.getElementById('btn-mode-select').addEventListener('click', function () { setMode('select'); });
        document.getElementById('btn-mode-edge').addEventListener('click', function () { setMode('edge'); });
        document.getElementById('btn-add-junction').addEventListener('click', addJunctionNode);
        document.getElementById('btn-add-floating').addEventListener('click', addFloatingNode);
        document.getElementById('edge-panel-delete').addEventListener('click', deleteSelectedEdge);
        document.getElementById('edge-panel-type').addEventListener('change', function () {
            var val = this.value;
            updateSelectedEdge(function (e) { e.type = val; });
        });
        document.getElementById('edge-panel-shape').addEventListener('change', function () {
            var val = this.value;
            updateSelectedEdge(function (e) { e.shape = val; });
        });
        document.getElementById('edge-panel-bend').addEventListener('input', function () {
            var val = parseInt(this.value, 10);
            updateSelectedEdge(function (e) { e.bend = val; });
        });
        document.getElementById('edge-panel-color').addEventListener('change', function () {
            var val = this.value;
            if (selectedTreeLink) {
                updateSelectedTreeLinkColor(val);
            } else {
                updateSelectedEdge(function (e) { e.color = val; });
            }
        });
        containerEl.addEventListener('click', function (e) {
            if (interactionMode !== 'edge') return;
            var nodeEl = e.target.closest('jmnode');
            if (!nodeEl) return;
            var nodeid = nodeEl.getAttribute('nodeid');
            if (nodeid) {
                e.stopPropagation();
                onEdgeModeNodeClick(nodeid);
            }
        }, true);
        document.addEventListener('click', function (e) {
            if (!edgePanelEl.contains(e.target) && e.target !== flowCanvas && selectedEdgeId) {
                selectedEdgeId = null;
                hideEdgePanel();
                redrawFlowEdges();
            }
        });
    }

    /** 初始化 jsMind */
    function initMindMap() {
        var options = {
            container: 'jsmind_container',
            theme: 'primary',
            editable: true,
            view: {
                engine: 'canvas',
                draggable: true,
                hspace: 30,
                vspace: 20,
                pspace: 13,
            },
            shortcut: { enable: true },
            plugin: {
                screenshot: {
                    background: '#ffffff',
                    watermark: { left: '', right: '' },
                },
                draggable_node: {},
            },
        };

        jm = new jsMind(options);

        // 用自定义线条渲染跳过「独立节点及其后代」和「有自由偏移的树节点子树」的树形连线。
        // 这些节点的实际位置由 applyTreeOffsets 覆盖（元素 style 含 data.offset 偏移），
        // 而 layout.offset 保持纯净（jsMind 布局基准），故 jsMind 画的线会脱节；
        // 改由 flow 层按元素实际位置重画（drawOffsetSubtreeLines / drawFloatingSubtreeLines）。
        var origDrawLine = jm.view.graph.draw_line.bind(jm.view.graph);
        jm.view.graph.draw_line = function (pout, pin, offset, color) {
            if (isCustomLineTarget(pin)) return;
            // 选中的树形连线（jsMind 原生绘制的）：若用户自定义了颜色则用之，
            // 否则用高亮色标识选中态（自定义颜色优先，保证改色立即可见）
            if (selectedTreeLink) {
                var selNode = jm.get_node(selectedTreeLink.childId);
                if (selNode) {
                    var p = jm.layout.get_node_point_in(selNode);
                    if (p && Math.abs(p.x - pin.x) < 2 && Math.abs(p.y - pin.y) < 2) {
                        var customColor = selNode.data && selNode.data['leading-line-color'];
                        origDrawLine(pout, pin, offset, customColor || '#4a90e2');
                        return;
                    }
                }
            }
            origDrawLine(pout, pin, offset, color);
        };

        /** 判断连线终点 pin 是否属于「需要 flow 层自绘连线」的节点：
            独立节点及其后代、有 offset 偏移的树节点的后代，或正在拖动的子树。 */
        function isCustomLineTarget(pin) {
            var nodes = jm.mind.nodes;
            for (var id in nodes) {
                var n = nodes[id];
                if (n.isroot) continue;
                var custom = (n.data && n.data.floating) || isFloatingDescendant(n) || hasOffsetAncestor(n) || isInActiveDrag(n);
                if (!custom) continue;
                var p = jm.layout.get_node_point_in(n);
                if (p && Math.abs(p.x - pin.x) < 2 && Math.abs(p.y - pin.y) < 2) return true;
            }
            return false;
        }

        /** 判断节点的祖先链上是否有 offset 偏移（或自身有偏移，或正在拖动子树内）。
            独立节点（floating）是自由体系，不继承父级的树偏移，遇到即停止。 */
        function hasOffsetAncestor(node) {
            var p = node;
            while (p) {
                if (p.data && p.data.floating) return false; // 独立节点不参与树偏移
                if (p.data && (p.data['offset-x'] || p.data['offset-y'])) return true;
                p = p.parent;
            }
            return false;
        }

        /** 判断节点是否在正在拖动的子树内（含自身） */
        function isInActiveDrag(node) {
            if (!activeDragIds) return false;
            var p = node;
            while (p) {
                if (activeDragIds[p.id]) return true;
                p = p.parent;
            }
            return false;
        }

        /** 判断节点的祖先链上是否有独立节点 */
        function isFloatingDescendant(node) {
            var p = node.parent;
            while (p && !p.isroot) {
                if (p.data && p.data.floating) return true;
                p = p.parent;
            }
            return false;
        }

        // 事件监听：编辑后自动保存并刷新大纲，选中后同步高亮大纲与属性面板
        jm.add_event_listener(function (type, data) {
            // jsMind.event_type: 1=show, 2=resize, 3=edit, 4=select
            if (type === jsMind.event_type.edit) {
                markDirty();
                recordHistory();
                autoSave();
                renderOutline();
                redrawFlowEdges();
                // 删除节点时清理其连线：data.node 是父节点，被删节点 id 在 data.data[0]
                if (data && data.evt === 'remove_node') {
                    var removedId = (data.data && data.data[0]) || (data.node && data.node.id);
                    if (removedId) cleanupEdgesForNode(removedId);
                }
            } else if (type === jsMind.event_type.show) {
                renderOutline();
                applyCustomNodeStyles();
                applyJunctionStyles();
                applyTreeOffsets();
                applyPageProps();
                bindNodeStyleObserver();
                redrawFlowEdges();
            } else if (type === jsMind.event_type.resize) {
                redrawFlowEdges();
            } else if (type === jsMind.event_type.select) {
                syncOutlineSelection();
                updateInspector();
            }
        });

        // 优先从 localStorage 恢复上次编辑的内容
        var saved = null;
        try {
            saved = localStorage.getItem(STORAGE_KEY);
        } catch (e) {
            /* 忽略隐私模式等异常 */
        }
        if (saved) {
            try {
                jm.show(JSON.parse(saved));
                var savedTitle = localStorage.getItem(STORAGE_TITLE_KEY);
                if (savedTitle) {
                    titleInput.value = savedTitle;
                }
                return;
            } catch (e) {
                console.error('恢复本地数据失败，加载默认导图', e);
            }
        }
        jm.show(getDefaultMind());
    }

    /* ---------------- 大纲结构面板 ---------------- */

    /** 重建整个大纲（节点树可能发生了结构性变化） */
    function renderOutline() {
        var data = jm.get_data('node_tree');
        outlineEl.innerHTML = '';
        outlineEl.appendChild(buildOutlineItem(data.data, true));
        syncOutlineSelection();
        restoreOutlineFocus();
    }

    /** 递归构建大纲条目 */
    function buildOutlineItem(nodeData, isRoot) {
        var item = document.createElement('div');
        item.className = 'outline-item';

        var row = document.createElement('div');
        row.className = 'outline-row' + (isRoot ? ' root-row' : '');
        row.dataset.nodeid = nodeData.id;
        row.tabIndex = 0;

        var topic = document.createElement('span');
        topic.className = 'topic';
        topic.textContent = nodeData.topic || '(未命名)';
        row.appendChild(topic);

        var ops = document.createElement('span');
        ops.className = 'ops';
        if (!isRoot) {
            ops.appendChild(makeOpBtn('promote', '⇤', '升级：与父节点同级（Shift+Tab）'));
            ops.appendChild(makeOpBtn('demote', '⇥', '降级：成为上一个同级节点的子节点（Tab）'));
        }
        ops.appendChild(makeOpBtn('add', '＋', '添加子节点（Insert）'));
        ops.appendChild(makeOpBtn('rename', '✎', '重命名（双击 / F2）'));
        if (!isRoot) {
            ops.appendChild(makeOpBtn('delete', '✕', '删除（Delete）'));
        }
        row.appendChild(ops);
        item.appendChild(row);

        if (nodeData.children && nodeData.children.length > 0) {
            var childrenBox = document.createElement('div');
            childrenBox.className = 'outline-children';
            nodeData.children.forEach(function (child) {
                childrenBox.appendChild(buildOutlineItem(child, false));
            });
            item.appendChild(childrenBox);
        }
        return item;
    }

    function makeOpBtn(op, text, title) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'op-btn';
        btn.dataset.op = op;
        btn.title = title;
        btn.textContent = text;
        return btn;
    }

    /** 大纲选中行与 jsMind 选中节点同步 */
    function syncOutlineSelection() {
        var selected = jm.get_selected_node();
        var selectedId = selected ? selected.id : null;
        outlineEl.querySelectorAll('.outline-row.selected').forEach(function (row) {
            row.classList.remove('selected');
        });
        if (selectedId) {
            var row = outlineEl.querySelector('.outline-row[data-nodeid="' + selectedId + '"]');
            if (row) {
                row.classList.add('selected');
            }
        }
    }

    /** 重绘后恢复焦点行 */
    function restoreOutlineFocus() {
        if (!lastActiveNodeId) return;
        var row = outlineEl.querySelector('.outline-row[data-nodeid="' + lastActiveNodeId + '"]');
        if (row && outlineEl.contains(document.activeElement)) {
            row.focus();
        }
    }

    /** 大纲行内重命名 */
    function startInlineEdit(row, nodeid) {
        var node = jm.get_node(nodeid);
        if (!node || row.querySelector('.outline-edit-input')) return;
        var topicEl = row.querySelector('.topic');
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'outline-edit-input';
        input.value = node.topic;
        row.replaceChild(input, topicEl);
        input.focus();
        input.select();

        var done = false;
        function commit(save) {
            if (done) return;
            done = true;
            var val = input.value.trim();
            if (save && val && val !== node.topic) {
                // update_node 触发 edit 事件，大纲自动重绘
                jm.update_node(nodeid, val);
            } else {
                renderOutline();
            }
        }
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                commit(true);
            } else if (e.key === 'Escape') {
                commit(false);
            }
            e.stopPropagation();
        });
        input.addEventListener('blur', function () {
            commit(true);
        });
        input.addEventListener('click', function (e) {
            e.stopPropagation();
        });
    }

    /** 升级：将节点提升为父节点的同级（紧随其后） */
    function promoteNode(nodeid) {
        var node = jm.get_node(nodeid);
        if (!node || node.isroot) return;
        var parent = node.parent;
        if (parent.isroot) {
            showStatus('一级分支不能再升级');
            return;
        }
        var grand = parent.parent;
        var idx = grand.children.indexOf(parent);
        var beforeid =
            idx === grand.children.length - 1 ? '_last_' : grand.children[idx + 1].id;
        jm.move_node(nodeid, beforeid, grand.id, parent.direction);
        jm.select_node(nodeid);
        lastActiveNodeId = nodeid;
        showStatus('已升级节点');
    }

    /** 降级：将节点变为上一个同级节点的子节点 */
    function demoteNode(nodeid) {
        var node = jm.get_node(nodeid);
        if (!node || node.isroot) return;
        var parent = node.parent;
        var idx = parent.children.indexOf(node);
        if (idx <= 0) {
            showStatus('前面没有同级节点，无法降级');
            return;
        }
        var prev = parent.children[idx - 1];
        jm.move_node(nodeid, '_last_', prev.id, prev.direction);
        if (!prev.expanded) {
            jm.expand_node(prev.id);
        }
        jm.select_node(nodeid);
        lastActiveNodeId = nodeid;
        showStatus('已降级节点');
    }

    /** 在大纲中添加子节点并立即进入重命名 */
    function outlineAddChild(nodeid) {
        var parent = jm.get_node(nodeid);
        if (!parent) return;
        if (!parent.expanded) {
            jm.expand_node(nodeid);
        }
        var newid = jsMind.util.uuid.newid();
        jm.add_node(parent, newid, '新节点');
        jm.select_node(newid);
        lastActiveNodeId = newid;
        // 大纲重绘由 edit 事件异步触发，等待后聚焦并开始重命名
        setTimeout(function () {
            var row = outlineEl.querySelector('.outline-row[data-nodeid="' + newid + '"]');
            if (row) {
                startInlineEdit(row, newid);
            }
        }, 60);
    }

    /** 在大纲中删除节点 */
    function outlineRemoveNode(nodeid) {
        var node = jm.get_node(nodeid);
        if (!node) return;
        if (node.isroot) {
            showStatus('根节点不能删除');
            return;
        }
        lastActiveNodeId = node.parent.id;
        jm.remove_node(nodeid);
    }

    /** 大纲点击事件委托 */
    function bindOutlineEvents() {
        outlineEl.addEventListener('click', function (e) {
            var row = e.target.closest('.outline-row');
            if (!row) return;
            var nodeid = row.dataset.nodeid;
            var btn = e.target.closest('[data-op]');
            if (btn) {
                e.stopPropagation();
                switch (btn.dataset.op) {
                    case 'promote':
                        promoteNode(nodeid);
                        break;
                    case 'demote':
                        demoteNode(nodeid);
                        break;
                    case 'add':
                        outlineAddChild(nodeid);
                        break;
                    case 'rename':
                        startInlineEdit(row, nodeid);
                        break;
                    case 'delete':
                        outlineRemoveNode(nodeid);
                        break;
                }
                return;
            }
            lastActiveNodeId = nodeid;
            jm.select_node(nodeid);
            // 确保属性面板可见
            inspectorBody.classList.remove('disabled');
        });

        outlineEl.addEventListener('dblclick', function (e) {
            var topicEl = e.target.closest('.topic');
            if (!topicEl) return;
            var row = topicEl.closest('.outline-row');
            if (row) {
                startInlineEdit(row, row.dataset.nodeid);
            }
        });

        outlineEl.addEventListener('keydown', function (e) {
            if (e.target.classList.contains('outline-edit-input')) return;
            var row = e.target.closest('.outline-row');
            if (!row) return;
            var nodeid = row.dataset.nodeid;
            switch (e.key) {
                case 'Tab':
                    e.preventDefault();
                    if (e.shiftKey) {
                        promoteNode(nodeid);
                    } else {
                        demoteNode(nodeid);
                    }
                    break;
                case 'F2':
                case 'Enter':
                    e.preventDefault();
                    startInlineEdit(row, nodeid);
                    break;
                case 'Delete':
                    e.preventDefault();
                    outlineRemoveNode(nodeid);
                    break;
                case 'Insert':
                    e.preventDefault();
                    outlineAddChild(nodeid);
                    break;
            }
        });
    }

    /** 显示节点属性区 */
    function showNodeProps() {
        inspectorTitle.textContent = '🎛️ 节点属性';
        inspectorBody.classList.remove('hidden');
        pagePropsEl.classList.add('hidden');
    }

    /** 显示页面属性区（点击空白处） */
    function showPageProps() {
        inspectorTitle.textContent = '📄 页面属性';
        inspectorTopic.textContent = '点击节点编辑节点属性';
        inspectorBody.classList.add('hidden');
        pagePropsEl.classList.remove('hidden');
        // 回显当前页面属性
        var data = jm.get_data('node_tree');
        var page = data.page || {};
        document.getElementById('page-name').value = getMindName();
        document.getElementById('page-width').value = page.width || '';
        document.getElementById('page-height').value = page.height || '';
        document.getElementById('page-bgcolor').value = page.bgcolor || '#f4f4f4';
        document.getElementById('export-bgcolor').value = (jm.screenshot && jm.screenshot.options.background) || '#ffffff';
    }

    /* ------ 页面属性应用 ------ */

    /** 读取/写入页面属性（存在数据顶层 page 字段，随序列化保存） */
    function getPageProps() {
        var data = jm.get_data('node_tree');
        return data.page || {};
    }

    function savePageProps(mutator) {
        var data = jm.get_data('node_tree');
        if (!data.page) data.page = {};
        mutator(data.page);
        // page 是顶层自定义字段，jsMind 序列化不会保留，需存到根节点 data 里
        var root = jm.get_node('root');
        if (root) {
            root.data['page-props'] = data.page;
        }
        autoSave();
    }

    /** 从根节点恢复页面属性 */
    function loadPageProps() {
        var root = jm.get_node('root');
        return (root && root.data['page-props']) || {};
    }

    function applyPageProps() {
        var page = loadPageProps();
        var container = containerEl;
        // 页面背景色
        if (page.bgcolor) {
            container.style.background = page.bgcolor;
            var inner = container.querySelector('.jsmind-inner');
            if (inner) inner.style.background = page.bgcolor;
        }
        // 画布尺寸
        if (page.width || page.height) {
            var inner2 = container.querySelector('.jsmind-inner');
            if (inner2) {
                if (page.width) inner2.style.minWidth = page.width + 'px';
                if (page.height) inner2.style.minHeight = page.height + 'px';
            }
        }
        // 导图名称
        if (page.name) {
            titleInput.value = page.name;
        }
    }

    function applyPageName() {
        var name = document.getElementById('page-name').value.trim();
        titleInput.value = name;
        savePageProps(function (p) { p.name = name; });
        showStatus('已更新导图名称');
    }

    function applyPageSize() {
        var w = parseInt(document.getElementById('page-width').value, 10);
        var h = parseInt(document.getElementById('page-height').value, 10);
        savePageProps(function (p) {
            if (w > 0) { p.width = w; } else { delete p.width; }
            if (h > 0) { p.height = h; } else { delete p.height; }
        });
        applyPageProps();
        jm.resize();
        showStatus('已调整画布尺寸');
    }

    function applyPageBg() {
        var color = document.getElementById('page-bgcolor').value;
        savePageProps(function (p) { p.bgcolor = color; });
        applyPageProps();
        showStatus('已更新页面背景色');
    }

    function applyExportBg() {
        var color = document.getElementById('export-bgcolor').value;
        if (jm.screenshot) {
            jm.screenshot.options.background = color;
        }
        savePageProps(function (p) { p.exportBgcolor = color; });
        showStatus('已更新导出背景色');
    }

    /* ---------------- 节点属性面板 ---------------- */

    /** 选中节点时在右侧面板同步显示其属性 */
    function updateInspector() {
        var node = jm.get_selected_node();
        selectedNodeId = node ? node.id : null;
        if (!node) {
            // 未选中节点：显示页面属性
            showPageProps();
            return;
        }
        // 选中节点：显示节点属性
        showNodeProps();
        inspectorBody.classList.remove('disabled');
        inspectorTopic.textContent = node.topic;

        // 从序列化数据读取自定义属性：node_tree 格式会把节点扩展字段平铺到节点顶层，
        // 这样读到的才是包含 width/height/custom-shape/颜色等完整持久化状态
        var treeNode = findTreeNode(jm.get_data('node_tree').data, node.id) || {};

        // 大小：有自定义值则回显；无则显示当前实际渲染尺寸（默认/主题值）
        var el = node._data.view.element;
        document.getElementById('node-width').value =
            treeNode.width || (el ? Math.round(el.offsetWidth) : '');
        document.getElementById('node-height').value =
            treeNode.height || (el ? Math.round(el.offsetHeight) : '');

        // 形状：无自定义时显示"默认"
        var shape = treeNode['custom-shape'] || 'default';
        document.querySelectorAll('#shape-group .shape-btn').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.shape === shape);
        });

        document.getElementById('btn-remove-image').classList.toggle(
            'hidden',
            !treeNode['background-image']
        );

        // 颜色：有自定义值用自定义值，无则显示主题/默认计算色
        var cs = el ? getComputedStyle(el) : null;
        document.getElementById('node-bgcolor').value = treeNode['background-color']
            ? rgbToHex(treeNode['background-color'])
            : (cs ? rgbToHex(cs.backgroundColor) : '#ffffff');
        document.getElementById('node-fgcolor').value = treeNode['foreground-color']
            ? rgbToHex(treeNode['foreground-color'])
            : (cs ? rgbToHex(cs.color) : '#000000');

        // 文字对齐：无自定义时显示居中（jsMind 节点默认居中）
        var halign = treeNode['text-halign'] || 'center';
        document.querySelectorAll('#halign-group .shape-btn').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.align === halign);
        });
        var valign = treeNode['text-valign'] || 'middle';
        document.querySelectorAll('#valign-group .shape-btn').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.align === valign);
        });

        // 换行方式：默认自动
        var wrap = treeNode['text-wrap'] || 'auto';
        document.querySelectorAll('#wrap-group .shape-btn').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.wrap === wrap);
        });
    }

    /**
     * 设置文字对齐 / 换行方式（通用）
     * 对齐（水平/垂直）始终写入字段（含默认值 center/middle），
     * 以便节点切换为 flex 容器使对齐生效；换行 auto 时删除字段（恢复默认）。
     * @param {string} field 数据字段名，如 text-halign / text-valign / text-wrap
     * @param {string} value 值
     * @param {boolean} keepDefault 为 true 时默认值也写入（对齐用），false 时默认值删除（换行用）
     */
    function applyTextStyle(field, value, keepDefault) {
        var node = jm.get_selected_node();
        if (!node) return;
        applyNodeData(node.id, function (n) {
            if (keepDefault) {
                n[field] = value;
            } else if (value === 'auto') {
                delete n[field];
            } else {
                n[field] = value;
            }
        });
        showStatus('已更新文字样式');
    }

    function rgbToHex(color) {
        if (!color) return '#000000';
        if (color.charAt(0) === '#') return color;
        var m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return '#000000';
        var hex = function (n) {
            return ('0' + parseInt(n, 10).toString(16)).slice(-2);
        };
        return '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
    }

    /** 应用节点尺寸 */
    function applyNodeSize() {
        var node = jm.get_selected_node();
        if (!node) return;
        var w = parseInt(document.getElementById('node-width').value, 10);
        var h = parseInt(document.getElementById('node-height').value, 10);
        applyNodeData(node.id, function (n) {
            if (w > 0) { n.width = w; } else { delete n.width; }
            if (h > 0) { n.height = h; } else { delete n.height; }
        });
        showStatus('已调整节点大小');
    }

    /** 应用节点外框形状 */
    function applyNodeShape(shape) {
        var node = jm.get_selected_node();
        if (!node) return;
        var needsMeasure = (shape === 'diamond' || shape === 'triangle');
        applyNodeData(node.id, function (n) {
            if (shape === 'default') {
                delete n['custom-shape'];
            } else {
                n['custom-shape'] = shape;
            }
            // 不再在切形状时主动清除尺寸：用户可能已手动设置过宽高，
            // 尺寸是否生效交给 jsMind 的 data.width/height 渲染逻辑处理，
            // 保留尺寸能让选中回显、持久化、用户手动调整的行为一致。
        });
        // 菱形/三角形采用 clip-path 绘制，文字可见区远小于包围盒，
        // 必须显式给定宽高，否则按自适应文本宽度绘制会显得过大
        if (needsMeasure) {
            // 等待 jm.show() 重渲染完成后再测量（show 事件异步触发）
            setTimeout(function () {
                autoSizeForClipShape(node.id, shape);
            }, 250);
        }
        showStatus('已更改节点形状');
    }

    /**
     * 为菱形/三角形自动测量文本尺寸并写入合适的宽高
     * 菱形的文字有效区为中心内接矩形（宽 W/2、高 H/2），
     * 因此设 W ≈ 1.9*textW，H ≈ 2.4*textH；
     * 三角形文字集中在下部，同理处理。
     */
    function autoSizeForClipShape(nodeid, shape) {
        var node = jm.get_node(nodeid);
        if (!node) return;
        var el = node._data.view.element;
        if (!el) return;
        // 临时移除裁剪以测量文本自然尺寸
        var prevShape = el.getAttribute('data-shape');
        el.removeAttribute('data-shape');
        el.style.width = '';
        el.style.height = '';
        var textW = el.offsetWidth;
        var textH = el.offsetHeight;
        if (prevShape) el.setAttribute('data-shape', prevShape);
        var w, h;
        if (shape === 'diamond') {
            w = Math.max(Math.ceil(textW * 1.9), 90);
            h = Math.max(Math.ceil(textH * 2.4), 60);
        } else {
            // triangle：文字在三角形下部约 1/2 区域
            w = Math.max(Math.ceil(textW * 1.6), 90);
            h = Math.max(Math.ceil(textH * 2.2), 56);
        }
        applyNodeData(nodeid, function (n) {
            n.width = w;
            n.height = h;
        });
        updateInspector();
    }

    /** 应用节点颜色 */
    function applyNodeColor() {
        var node = jm.get_selected_node();
        if (!node) return;
        jm.set_node_color(
            node.id,
            document.getElementById('node-bgcolor').value,
            document.getElementById('node-fgcolor').value
        );
        autoSave();
        showStatus('已更改节点颜色');
    }

    /**
     * 修改节点扩展字段并完整刷新视图（布局 + 渲染）
     * 适用于 width / height / custom-shape / background-image 等需要重新布局的修改
     * 注意：node_tree 序列化会把节点 data 平铺到节点对象顶层，
     * 因此这里直接在节点顶层字段上读写（width、custom-shape 等）。
     */
    function applyNodeData(nodeid, mutator) {
        var data = jm.get_data('node_tree');
        var found = findTreeNode(data.data, nodeid);
        if (!found) return;
        mutator(found);
        var keepSelected = nodeid;
        jm.show(data);
        jm.select_node(keepSelected);
        autoSave();
    }

    function findTreeNode(treeNode, nodeid) {
        if (treeNode.id === nodeid) return treeNode;
        var children = treeNode.children || [];
        for (var i = 0; i < children.length; i++) {
            var r = findTreeNode(children[i], nodeid);
            if (r) return r;
        }
        return null;
    }

    /**
     * 将 jsMind 的单行 input 编辑器替换为 textarea，支持手动换行输入
     * - Shift+Enter / 直接回车：插入换行
     * - Ctrl+Enter / Esc：结束编辑
     * 保留 jsMind 原有的 edit_node_start / edit_node_end 流程
     */
    function patchEditorForMultiline() {
        var view = jm.view;
        var oldEditor = view.e_editor;
        if (!oldEditor || oldEditor.tagName === 'TEXTAREA') return;

        var editor = document.createElement('textarea');
        editor.className = oldEditor.className + ' multiline';
        editor.rows = 1;
        // 移除旧编辑器上 jsMind 绑定的监听，替换元素
        var clone = editor;
        oldEditor.parentNode && oldEditor.parentNode.replaceChild(clone, oldEditor);
        view.e_editor = clone;

        clone.addEventListener('keydown', function (e) {
            // Ctrl+Enter 或 Esc 提交；普通回车换行
            if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey)) || e.key === 'Escape') {
                view.edit_node_end();
                e.stopPropagation();
                e.preventDefault();
            }
            e.stopPropagation();
        });
        clone.addEventListener('blur', function () {
            view.edit_node_end();
        });
        // 自适应高度
        clone.addEventListener('input', function () {
            clone.style.height = 'auto';
            clone.style.height = clone.scrollHeight + 'px';
        });
    }

    /**
     * 所有节点渲染完成后，应用自定义形状等扩展样式
     * （通过观察 e_nodes 的 DOM 变化实现，jsMind 重绘后自动恢复）
     */
    function applyCustomNodeStyles() {
        var data = jm.get_data('node_tree');
        (function walk(n) {
            var el = containerEl.querySelector('jmnode[nodeid="' + n.id + '"]');
            if (el) {
                // node_tree 序列化后扩展字段平铺在节点顶层
                var shape = n['custom-shape'];
                if (shape) {
                    el.setAttribute('data-shape', shape);
                } else {
                    el.removeAttribute('data-shape');
                }
                // 文字对齐与换行
                setOrRemoveAttr(el, 'data-halign', n['text-halign']);
                setOrRemoveAttr(el, 'data-valign', n['text-valign']);
                setOrRemoveAttr(el, 'data-wrap', n['text-wrap']);
            }
            (n.children || []).forEach(walk);
        })(data.data);
    }

    function setOrRemoveAttr(el, attr, value) {
        if (value) {
            el.setAttribute(attr, value);
        } else {
            el.removeAttribute(attr);
        }
    }

    var styleObserver = null;
    function bindNodeStyleObserver() {
        if (styleObserver) return; // 已绑定
        var target = jm && jm.view ? jm.view.e_nodes : null;
        if (!target) return;
        styleObserver = new MutationObserver(function () {
            applyCustomNodeStyles();
            applyJunctionStyles();
        });
        styleObserver.observe(target, { childList: true, subtree: true });
        applyCustomNodeStyles();
        applyJunctionStyles();
    }

    /* ---------------- 表情图标与用户图片 ---------------- */

    /** 加载本地表情目录 */
    function loadEmojiCatalog() {
        // cache:'no-store' 确保目录文件更新后及时生效（避免浏览器缓存旧目录）
        return fetch('emoji/catalog.json', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (catalog) {
                emojiCatalog = catalog;
                renderEmojiTabs(Object.keys(catalog)[0]);
            })
            .catch(function (e) {
                console.error('表情目录加载失败', e);
            });
    }

    function renderEmojiTabs(activeKey) {
        emojiTabs.innerHTML = '';
        Object.keys(emojiCatalog).forEach(function (key) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = emojiCatalog[key].name;
            btn.classList.toggle('active', key === activeKey);
            btn.addEventListener('click', function () {
                renderEmojiTabs(key);
            });
            emojiTabs.appendChild(btn);
        });
        renderEmojiGrid(activeKey);
    }

    function renderEmojiGrid(key) {
        emojiGrid.innerHTML = '';
        emojiCatalog[key].emojis.forEach(function (emoji) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = emoji;
            btn.title = '插入 ' + emoji;
            btn.addEventListener('click', function () {
                insertEmoji(emoji);
            });
            emojiGrid.appendChild(btn);
        });
    }

    function openEmojiPanel() {
        if (!jm.get_selected_node()) {
            showStatus('请先选中一个节点');
            return;
        }
        emojiPanel.classList.remove('hidden');
    }

    function closeEmojiPanel() {
        emojiPanel.classList.add('hidden');
    }

    /** 将表情插入到当前选中节点的文本开头 */
    function insertEmoji(emoji) {
        var node = jm.get_selected_node();
        if (!node) return;
        var topic = node.topic || '';
        // 避免重复插入同一个表情
        if (topic.indexOf(emoji) !== -1) {
            closeEmojiPanel();
            return;
        }
        jm.update_node(node.id, emoji + ' ' + topic);
        closeEmojiPanel();
        showStatus('已插入表情');
    }

    /** 选择用户图片并插入为节点背景图 */
    function insertUserImage(file) {
        var node = jm.get_selected_node();
        if (!node) return;
        var reader = new FileReader();
        reader.onload = function () {
            var img = new Image();
            img.onload = function () {
                // 限制节点图片尺寸，避免撑破布局
                var maxW = 200, maxH = 160;
                var w = img.naturalWidth, h = img.naturalHeight;
                var scale = Math.min(maxW / w, maxH / h, 1);
                w = Math.round(w * scale);
                h = Math.round(h * scale);
                // 通过平铺字段写入并整体刷新，渲染与持久化一次性完成
                applyNodeData(node.id, function (n) {
                    n['background-image'] = reader.result;
                    n.width = w;
                    n.height = h;
                });
                showStatus('已插入图片');
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    }

    function removeUserImage() {
        var node = jm.get_selected_node();
        if (!node) return;
        applyNodeData(node.id, function (n) {
            delete n['background-image'];
            delete n['background-rotation'];
            delete n.width;
            delete n.height;
        });
        updateInspector();
        showStatus('已移除图片');
    }

    /* ---------------- 右键菜单 ---------------- */

    function showCtxMenu(x, y) {
        ctxMenu.classList.remove('hidden');
        var mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
        var vw = window.innerWidth, vh = window.innerHeight;
        ctxMenu.style.left = Math.min(x, vw - mw - 8) + 'px';
        ctxMenu.style.top = Math.min(y, vh - mh - 8) + 'px';
    }

    function hideCtxMenu() {
        ctxMenu.classList.add('hidden');
    }

    /** 自动排版：重新布局所有节点，防止重叠；清除自由偏移并保存 */
    function autoLayout() {
        // 清除所有手动自由移动偏移，让排版基于干净布局
        var data = jm.get_data('node_tree');
        (function walk(n) {
            var node = jm.get_node(n.id);
            if (node && node.data) {
                delete node.data['offset-x'];
                delete node.data['offset-y'];
            }
            (n.children || []).forEach(walk);
        })(data.data);
        jm.layout.layout();
        jm.view.show(true);
        recordHistory();
        autoSave();
        showStatus('已自动排版');
    }

    function bindContextMenu() {
        containerEl.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            // 如果右键点在节点上，优先选中该节点
            var nodeEl = e.target.closest('jmnode');
            if (nodeEl) {
                var nodeid = nodeEl.getAttribute('nodeid');
                if (nodeid) {
                    jm.select_node(nodeid);
                }
            }
            var hasNode = !!jm.get_selected_node();
            ctxMenu.querySelectorAll('[data-cmd="add-child"],[data-cmd="add-brother"],[data-cmd="edit"],[data-cmd="remove"],[data-cmd="add-edge"],[data-cmd="add-loop"]').forEach(function (btn) {
                btn.disabled = !hasNode;
            });
            // 按节点类型/状态控制新增命令
            var selNode = jm.get_selected_node();
            var isFloating = selNode && selNode.data && selNode.data.floating;
            var hasChildren = selNode && selNode.children && selNode.children.length > 0;
            // 「转为子节点」仅独立节点可用
            var toChildBtn = ctxMenu.querySelector('[data-cmd="to-child"]');
            if (toChildBtn) toChildBtn.disabled = !hasNode || !isFloating;
            // 「展开/收起」仅有子节点时可用，按当前状态显示
            var expandBtn = ctxMenu.querySelector('[data-cmd="expand"]');
            var collapseBtn = ctxMenu.querySelector('[data-cmd="collapse"]');
            if (expandBtn) expandBtn.disabled = !hasNode || !hasChildren || (selNode && selNode.expanded !== false);
            if (collapseBtn) collapseBtn.disabled = !hasNode || !hasChildren || (selNode && selNode.expanded === false);
            showCtxMenu(e.clientX, e.clientY);
        });

        document.addEventListener('click', function (e) {
            if (!ctxMenu.contains(e.target)) hideCtxMenu();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') hideCtxMenu();
        });

        ctxMenu.addEventListener('click', function (e) {
            var btn = e.target.closest('[data-cmd]');
            if (!btn || btn.disabled) return;
            hideCtxMenu();
            switch (btn.dataset.cmd) {
                case 'auto-layout':
                    autoLayout();
                    break;
                case 'add-child':
                    addChildNode();
                    break;
                case 'add-brother':
                    addBrotherNode();
                    break;
                case 'edit':
                    editNode();
                    break;
                case 'add-edge': {
                    // 以当前节点为源，进入连线模式选目标
                    var sel = jm.get_selected_node();
                    if (sel) {
                        setMode('edge');
                        edgeSourceId = sel.id;
                        var el = containerEl.querySelector('jmnode[nodeid="' + sel.id + '"]');
                        if (el) el.classList.add('edge-source');
                        showStatus('已选源节点，点击目标节点完成连接');
                    }
                    break;
                }
                case 'add-loop': {
                    var sel2 = jm.get_selected_node();
                    if (sel2) addFlowEdge(sel2.id, sel2.id, 'loop');
                    break;
                }
                case 'remove':
                    removeNode();
                    break;
                case 'to-child': {
                    // 独立节点转为子节点（挂回根节点，参与树布局）
                    var selToChild = jm.get_selected_node();
                    if (selToChild && selToChild.data && selToChild.data.floating) {
                        convertFloatingToChild(selToChild);
                    }
                    break;
                }
                case 'expand': {
                    var selExp = jm.get_selected_node();
                    if (selExp) jm.expand_node(selExp);
                    break;
                }
                case 'collapse': {
                    var selCol = jm.get_selected_node();
                    if (selCol) jm.collapse_node(selCol);
                    break;
                }
            }
        });
    }

    /* ---------------- 节点操作 ---------------- */

    function getSelectedOrWarn() {
        var node = jm.get_selected_node();
        if (!node) {
            showStatus('请先选中一个节点');
        }
        return node;
    }

    function addChildNode() {
        var selected = getSelectedOrWarn();
        if (!selected) return;
        var nodeid = jsMind.util.uuid.newid();
        jm.add_node(selected, nodeid, '新节点');
    }

    function addBrotherNode() {
        var selected = getSelectedOrWarn();
        if (!selected) return;
        if (selected.isroot) {
            addChildNode();
            return;
        }
        var nodeid = jsMind.util.uuid.newid();
        jm.insert_node_after(selected, nodeid, '新节点');
    }

    function editNode() {
        var selected = getSelectedOrWarn();
        if (!selected) return;
        jm.begin_edit(selected);
    }

    function removeNode() {
        var selected = getSelectedOrWarn();
        if (!selected) return;
        if (selected.isroot) {
            showStatus('根节点不能删除');
            return;
        }
        jm.remove_node(selected);
    }

    /** 独立节点转为子节点：清除 floating 与自由坐标，重新参与树布局（挂回根节点下） */
    function convertFloatingToChild(node) {
        applyNodeData(node.id, function (n) {
            delete n.floating;
            delete n['free-x'];
            delete n['free-y'];
            delete n['offset-x'];
            delete n['offset-y'];
            delete n.junction;
        });
        // 移除自由节点样式类，恢复树节点外观
        var el = containerEl.querySelector('jmnode[nodeid="' + node.id + '"]');
        if (el) el.classList.remove('floating-node', 'floating-child', 'junction-node');
        showStatus('已转为子节点');
    }

    /* ---------------- 打开 / 保存（含加密 .hxmp） ---------------- */

    function openFile() {
        document.getElementById('file-input').click();
    }

    function onFileChosen(event) {
        var file = event.target.files[0];
        if (!file) return;
        jsMind.util.file.read(file, function (content, name) {
            var isHxmp = /\.hxmp$/i.test(name);
            if (isHxmp) {
                // 加密文件：弹密码框解密
                promptDecryptPassword(content, name);
            } else {
                loadPlainMind(content, name);
            }
        });
        event.target.value = '';
    }

    /** 打开明文导图文件（.jm/.json） */
    function loadPlainMind(content, name) {
        try {
            var mind = JSON.parse(content);
            jm.show(mind);
            var baseName = name.replace(/\.(jm|json|hxmp)$/i, '');
            titleInput.value = baseName;
            clearDirty();
            autoSave();
            showStatus('已打开：' + name);
        } catch (e) {
            alert('文件解析失败，请选择有效的 jsMind JSON 文件（.jm / .json）');
        }
    }

    /* ------ 加密 / 解密（AES-GCM + PBKDF2，Web Crypto API） ------ */

    var ENC_MARKER = 'HXMP1'; // 加密文件标识

    function bufToBase64(buf) {
        var bytes = new Uint8Array(buf);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }
    function base64ToBuf(b64) {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    async function deriveKey(password, salt) {
        var enc = new TextEncoder();
        var keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    /** 加密明文为 .hxmp 格式（JSON 包装 salt/iv/密文 base64） */
    async function encryptContent(plainText, password) {
        var salt = crypto.getRandomValues(new Uint8Array(16));
        var iv = crypto.getRandomValues(new Uint8Array(12));
        var key = await deriveKey(password, salt);
        var enc = new TextEncoder();
        var cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(plainText));
        return JSON.stringify({
            marker: ENC_MARKER,
            salt: bufToBase64(salt.buffer),
            iv: bufToBase64(iv.buffer),
            data: bufToBase64(cipherBuf),
        });
    }

    /** 解密 .hxmp 内容为明文。密码错误抛异常。 */
    async function decryptContent(content, password) {
        var pkg = JSON.parse(content);
        if (!pkg || pkg.marker !== ENC_MARKER) throw new Error('不是有效的加密文件');
        var salt = new Uint8Array(base64ToBuf(pkg.salt));
        var iv = new Uint8Array(base64ToBuf(pkg.iv));
        var cipherBuf = base64ToBuf(pkg.data);
        var key = await deriveKey(password, salt);
        var plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, cipherBuf);
        return new TextDecoder().decode(plainBuf);
    }

    /* ------ 保存格式选择对话框 ------ */

    var saveDialogEl = document.getElementById('save-dialog');
    var decryptDialogEl = document.getElementById('decrypt-dialog');

    /** 弹出保存格式选择框，返回 { format: 'plain'|'encrypted', password? } 或 null（取消） */
    function promptSaveFormat() {
        return new Promise(function (resolve) {
            saveDialogEl.classList.remove('hidden');
            var pwRow = document.getElementById('save-password-row');
            var errEl = document.getElementById('save-error');
            var pw1 = document.getElementById('save-password');
            var pw2 = document.getElementById('save-password2');
            pw1.value = ''; pw2.value = '';
            errEl.classList.add('hidden');
            pwRow.classList.add('hidden');
            saveDialogEl.querySelector('input[value="plain"]').checked = true;

            function onRadio() {
                var fmt = saveDialogEl.querySelector('input[name="save-format"]:checked').value;
                pwRow.classList.toggle('hidden', fmt !== 'encrypted');
                if (fmt === 'encrypted') pw1.focus();
            }
            saveDialogEl.querySelectorAll('input[name="save-format"]').forEach(function (r) {
                r.addEventListener('change', onRadio);
            });

            function cleanup() {
                saveDialogEl.classList.add('hidden');
                document.getElementById('save-confirm').onclick = null;
                document.getElementById('save-cancel').onclick = null;
            }
            document.getElementById('save-confirm').onclick = function () {
                var fmt = saveDialogEl.querySelector('input[name="save-format"]:checked').value;
                if (fmt === 'plain') { cleanup(); resolve({ format: 'plain' }); return; }
                // 加密：校验密码
                if (!pw1.value) { errEl.textContent = '请设置加密密码'; errEl.classList.remove('hidden'); return; }
                if (pw1.value !== pw2.value) { errEl.textContent = '两次密码不一致'; errEl.classList.remove('hidden'); return; }
                cleanup();
                resolve({ format: 'encrypted', password: pw1.value });
            };
            document.getElementById('save-cancel').onclick = function () { cleanup(); resolve(null); };
            // 回车确认
            [pw1, pw2].forEach(function (inp) {
                inp.onkeydown = function (e) { if (e.key === 'Enter') document.getElementById('save-confirm').click(); };
            });
        });
    }

    /** 弹出解密密码框，返回密码或 null（取消）。密码错误时循环提示。 */
    function promptDecryptPassword(content, name) {
        decryptDialogEl.classList.remove('hidden');
        var pw = document.getElementById('decrypt-password');
        var errEl = document.getElementById('decrypt-error');
        pw.value = '';
        errEl.classList.add('hidden');
        pw.focus();

        document.getElementById('decrypt-confirm').onclick = async function () {
            if (!pw.value) { errEl.textContent = '请输入密码'; errEl.classList.remove('hidden'); return; }
            try {
                var plain = await decryptContent(content, pw.value);
                decryptDialogEl.classList.add('hidden');
                loadPlainMind(plain, name);
            } catch (e) {
                errEl.textContent = '密码错误或文件已损坏，请重试';
                errEl.classList.remove('hidden');
                pw.select();
            }
        };
        document.getElementById('decrypt-cancel').onclick = function () {
            decryptDialogEl.classList.add('hidden');
            showStatus('已取消打开加密文件');
        };
        pw.onkeydown = function (e) { if (e.key === 'Enter') document.getElementById('decrypt-confirm').click(); };
    }

    /** 保存为文件。弹出格式选择框：明文 .jm 或加密 .hxmp。
        优先用 File System Access API 让用户选择保存位置，不支持时回退为下载。 */
    async function saveToLocal() {
        var choice = await promptSaveFormat();
        if (!choice) return; // 用户取消

        var data = jm.get_data('node_tree');
        data.meta.name = getMindName();
        var str = jsMind.util.json.json2string(data);
        var fileName, mime, content;
        if (choice.format === 'encrypted') {
            try {
                content = await encryptContent(str, choice.password);
            } catch (e) {
                alert('加密失败：' + e.message);
                return;
            }
            fileName = getMindName() + '.hxmp';
            mime = 'application/json';
        } else {
            content = str;
            fileName = getMindName() + '.jm';
            mime = 'text/jsmind';
        }

        // 优先：File System Access API（Chrome/Edge），弹出保存位置选择框
        if (window.showSaveFilePicker) {
            try {
                var ext = choice.format === 'encrypted' ? '.hxmp' : '.jm';
                var handle = await window.showSaveFilePicker({
                    suggestedName: fileName,
                    types: [{ description: '导图文件', accept: { 'application/json': ['.jm', '.json', '.hxmp'] } }],
                });
                var writable = await handle.createWritable();
                await writable.write(content);
                await writable.close();
                clearDirty();
                autoSave();
                showStatus('已' + (choice.format === 'encrypted' ? '加密' : '') + '保存到：' + handle.name);
                return;
            } catch (e) {
                if (e && e.name === 'AbortError') return;
                console.warn('showSaveFilePicker 失败，回退为下载', e);
            }
        }
        // 回退：浏览器下载
        jsMind.util.file.save(content, mime, fileName);
        clearDirty();
        autoSave();
        showStatus('已' + (choice.format === 'encrypted' ? '加密' : '') + '保存到本地文件');
    }

    /** 新建导图：若有未保存修改则提示保存（可选保存位置），然后清空为默认导图 */
    async function newFile() {
        if (isDirty) {
            var choice = window.confirm('当前导图有未保存的修改。\n\n点击「确定」先保存到文件（可选择保存位置），点击「取消」放弃修改直接新建。');
            if (choice) {
                await saveToLocal();
                // 用户在保存对话框中取消（仍是脏），则不新建
                if (isDirty) { showStatus('已取消新建'); return; }
            }
        }
        // 清空为默认导图
        clearDirty();
        regionSelection = null;
        selectedEdgeId = null;
        hideEdgePanel();
        titleInput.value = '我的思维导图';
        jm.show(getDefaultMind());
        initHistory();
        autoSave();
        showStatus('已新建导图');
    }

    /* ---------------- 导出 ---------------- */

    /**
     * 使用截图插件的内部绘制流程生成画布，并叠加流程连线层，
     * 供 PNG / PDF 导出复用
     */
    function captureCanvas() {
        var ss = jm.screenshot;
        var c = ss.create_canvas();
        var ctx = c.getContext('2d');
        ctx.scale(ss.dpr, ss.dpr);
        return Promise.resolve(ctx)
            .then(function () { return ss.draw_background(ctx); })
            .then(function () { return ss.draw_lines(ctx); })
            .then(function () { return ss.draw_nodes(ctx); })
            .then(function () {
                // 叠加流程连线层（画在节点之上，与画布上一致）
                if (flowCanvas && flowCanvas.width > 0) {
                    ctx.drawImage(flowCanvas, 0, 0, jm.view.size.w, jm.view.size.h);
                }
                var result = { canvas: c, cleanup: function () { ss.clear(c); } };
                return result;
            })
            .catch(function (err) {
                ss.clear(c);
                throw err;
            });
    }

    /** 导出 PNG 图片（含流程连线） */
    function exportPng() {
        captureCanvas()
            .then(function (result) {
                var c = result.canvas;
                var name = getMindName() + '.png';
                c.toBlob(function (blob) {
                    downloadBlob(blob, name);
                    result.cleanup();
                    showStatus('已导出 PNG 图片');
                }, 'image/png');
            })
            .catch(function (err) {
                console.error(err);
                // 回退到 jsMind 自带截图
                jm.screenshot.options.filename = getMindName();
                jm.shoot();
            });
    }

    /** 导出 PDF */
    function exportPdf() {
        showStatus('正在生成 PDF…');
        captureCanvas()
            .then(function (result) {
                var c = result.canvas;
                var imgData = c.toDataURL('image/png');
                var jsPDF = window.jspdf.jsPDF;

                // 按图片宽高比选择纸张方向
                var landscape = c.width > c.height;
                var pdf = new jsPDF({
                    orientation: landscape ? 'landscape' : 'portrait',
                    unit: 'pt',
                    format: 'a4',
                });
                var pageW = pdf.internal.pageSize.getWidth();
                var pageH = pdf.internal.pageSize.getHeight();
                var margin = 20;
                var maxW = pageW - margin * 2;
                var maxH = pageH - margin * 2;
                var scale = Math.min(maxW / c.width, maxH / c.height);
                var w = c.width * scale;
                var h = c.height * scale;
                pdf.addImage(imgData, 'PNG', (pageW - w) / 2, (pageH - h) / 2, w, h);
                pdf.save(getMindName() + '.pdf');
                result.cleanup();
                showStatus('已导出 PDF');
            })
            .catch(function (err) {
                console.error(err);
                alert('PDF 导出失败：' + err.message);
            });
    }

    /** HTML 转义 */
    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** 将节点树递归转换为嵌套列表 HTML */
    function nodeToHtml(node) {
        var html = '<li>' + escapeHtml(node.topic || '');
        if (node.children && node.children.length > 0) {
            html += '<ul>';
            node.children.forEach(function (child) {
                html += nodeToHtml(child);
            });
            html += '</ul>';
        }
        return html + '</li>';
    }

    /** 导出 Word 文档（.doc，Word 可直接打开 HTML 格式） */
    function exportWord() {
        var data = jm.get_data('node_tree');
        var name = getMindName();

        var bodyHtml =
            '<h1 style="text-align:center;">' + escapeHtml(name) + '</h1>' +
            '<ul>' + nodeToHtml(data.data) + '</ul>';

        var wordHtml =
            '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
            'xmlns:w="urn:schemas-microsoft-com:office:word" ' +
            'xmlns="http://www.w3.org/TR/REC-html40">' +
            '<head><meta charset="utf-8"><title>' + escapeHtml(name) + '</title></head>' +
            '<body>' + bodyHtml + '</body></html>';

        // 加 BOM 保证 Word 正确识别 UTF-8 中文
        var blob = new Blob(['﻿', wordHtml], { type: 'application/msword' });
        downloadBlob(blob, name + '.doc');
        showStatus('已导出 Word 文档');
    }

    /* ---------------- 事件绑定 ---------------- */

    function bindEvents() {
        document.getElementById('btn-toggle-outline').addEventListener('click', function () {
            sidebarEl.classList.toggle('hidden');
            // 容器尺寸变化后通知 jsMind 重新计算视图
            jm.resize();
        });
        btnToggleInspector.addEventListener('click', function () {
            inspectorEl.classList.toggle('hidden');
            jm.resize();
        });
        document.getElementById('btn-undo').addEventListener('click', undo);
        document.getElementById('btn-redo').addEventListener('click', redo);
        // 快捷键：Ctrl+Z 撤销，Ctrl+Y / Ctrl+Shift+Z 重做
        document.addEventListener('keydown', function (e) {
            // 不在输入框中时才响应
            if (e.target.closest('input, textarea, .outline-edit-input')) return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
                e.preventDefault();
                undo();
            } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
                e.preventDefault();
                redo();
            }
        });
        document.getElementById('btn-auto-layout').addEventListener('click', autoLayout);
        document.getElementById('btn-add-child').addEventListener('click', addChildNode);
        document.getElementById('btn-add-brother').addEventListener('click', addBrotherNode);
        document.getElementById('btn-edit').addEventListener('click', editNode);
        document.getElementById('btn-remove').addEventListener('click', removeNode);

        document.getElementById('btn-zoom-in').addEventListener('click', function () {
            jm.view.zoom_in();
        });
        document.getElementById('btn-zoom-out').addEventListener('click', function () {
            jm.view.zoom_out();
        });
        document.getElementById('btn-expand-all').addEventListener('click', function () {
            jm.expand_all();
        });
        document.getElementById('btn-collapse-all').addEventListener('click', function () {
            jm.collapse_all();
        });

        document.getElementById('btn-new').addEventListener('click', newFile);
        document.getElementById('btn-open').addEventListener('click', openFile);
        document.getElementById('file-input').addEventListener('change', onFileChosen);
        document.getElementById('btn-save').addEventListener('click', saveToLocal);

        document.getElementById('btn-export-png').addEventListener('click', exportPng);
        document.getElementById('btn-export-pdf').addEventListener('click', exportPdf);
        document.getElementById('btn-export-word').addEventListener('click', exportWord);

        titleInput.addEventListener('change', autoSave);

        // 右侧属性面板事件
        document.getElementById('btn-apply-size').addEventListener('click', applyNodeSize);
        document.getElementById('shape-group').addEventListener('click', function (e) {
            var btn = e.target.closest('.shape-btn');
            if (btn) applyNodeShape(btn.dataset.shape);
        });
        document.getElementById('btn-apply-color').addEventListener('click', applyNodeColor);
        // 文字对齐与换行
        document.getElementById('halign-group').addEventListener('click', function (e) {
            var btn = e.target.closest('.shape-btn');
            if (btn) applyTextStyle('text-halign', btn.dataset.align, true);
        });
        document.getElementById('valign-group').addEventListener('click', function (e) {
            var btn = e.target.closest('.shape-btn');
            if (btn) applyTextStyle('text-valign', btn.dataset.align, true);
        });
        document.getElementById('wrap-group').addEventListener('click', function (e) {
            var btn = e.target.closest('.shape-btn');
            if (btn) applyTextStyle('text-wrap', btn.dataset.wrap, false);
        });
        document.getElementById('btn-emoji').addEventListener('click', openEmojiPanel);
        document.getElementById('emoji-close').addEventListener('click', closeEmojiPanel);
        // 页面属性控件
        document.getElementById('page-name').addEventListener('change', applyPageName);
        document.getElementById('btn-apply-page-size').addEventListener('click', applyPageSize);
        document.getElementById('btn-apply-page-bg').addEventListener('click', applyPageBg);
        document.getElementById('btn-apply-export-bg').addEventListener('click', applyExportBg);
        // 点击画布空白处：取消选中节点，显示页面属性（框选/组拖动刚结束时除外）
        containerEl.addEventListener('click', function (e) {
            if (e.target.closest('jmnode') || e.target.closest('jmexpander')) return;
            if (interactionMode === 'edge') return;
            if (justFinishedRegion) return;
            jm.select_clear();
            showPageProps();
        });
        document.getElementById('btn-insert-image').addEventListener('click', function () {
            if (!jm.get_selected_node()) {
                showStatus('请先选中一个节点');
                return;
            }
            imageInput.click();
        });
        imageInput.addEventListener('change', function (e) {
            var file = e.target.files[0];
            if (file) insertUserImage(file);
            e.target.value = '';
        });
        document.getElementById('btn-remove-image').addEventListener('click', removeUserImage);
    }

    window.addEventListener('load', function () {
        initMindMap();
        patchEditorForMultiline();
        initFlowLayer();
        bindEvents();
        bindOutlineEvents();
        bindContextMenu();
        bindFlowEvents();
        bindFloatingDrag();
        bindDragEdge();
        bindRegionSelect();
        loadEmojiCatalog();
        initHistory();
        applyPageProps();
        showPageProps(); // 初始未选中节点，显示页面属性
        // 窗口尺寸变化时重画连线
        window.addEventListener('resize', redrawFlowEdges);
    });
})();
