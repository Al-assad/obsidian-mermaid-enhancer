import { Plugin } from 'obsidian';

interface ZoomState {
	scale: number;
	minScale: number;
	maxScale: number;
	isDragging: boolean;
	startX: number;
	startY: number;
	translateX: number;
	translateY: number;
	scaleIndicator?: HTMLElement;
	svg: SVGSVGElement;
	container: HTMLElement;
	// Original SVG dimensions (saved once)
	svgOriginalWidth: number;
	svgOriginalHeight: number;
}

export default class MermaidZoomPlugin extends Plugin {
	private readonly zoomStates = new Map<HTMLElement, ZoomState>();
	private readonly defaultMinScale = 0.1;
	private readonly defaultMaxScale = 5;
	private readonly defaultScale = 1;
	private mutationObserver?: MutationObserver;
	private resizeObserver?: ResizeObserver;
	private processedElements = new WeakSet<SVGSVGElement>();

	onload() {
		console.debug('Loading Mermaid Zoom plugin');

		// Set up observers
		this.setupMutationObserver();
		this.setupResizeObserver();

		// Initial processing of existing content
		this.app.workspace.onLayoutReady(() => {
			this.processAllMermaidDiagrams();
		});

		// Re-process when layout changes
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			this.processAllMermaidDiagrams();
		}));

		// Also listen for active leaf changes
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
			this.processAllMermaidDiagrams();
		}));

		// Listen for file open
		this.registerEvent(this.app.workspace.on('file-open', () => {
			// Delay to allow mermaid to render
			setTimeout(() => this.processAllMermaidDiagrams(), 200);
		}));
	}

	private setupResizeObserver() {
		this.resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const container = entry.target as HTMLElement;
				// 容器已从 DOM 中移除时，停止观察并清理状态
				if (!document.contains(container)) {
					this.resizeObserver?.unobserve(container);
					const contentWrapper = container.querySelector('.mermaid-zoom-content') as HTMLElement;
					if (contentWrapper) {
						this.zoomStates.delete(contentWrapper);
					}
					continue;
				}
				const contentWrapper = container.querySelector('.mermaid-zoom-content') as HTMLElement;
				if (!contentWrapper) continue;
				const state = this.zoomStates.get(contentWrapper);
				if (state) {
					this.fitToContainer(container, contentWrapper, state.svg, state);
				}
			}
		});
	}

	private setupMutationObserver() {
		this.mutationObserver = new MutationObserver((mutations) => {
			for (const mutation of Array.from(mutations)) {
				for (const node of Array.from(mutation.addedNodes)) {
					if (node instanceof HTMLElement || node instanceof SVGElement) {
						this.processPotentialMermaidElement(node);
					}
				}
			}
		});

		// Start observing the document body
		this.mutationObserver.observe(document.body, {
			childList: true,
			subtree: true
		});
	}

	private processPotentialMermaidElement(element: Element) {
		// Check if this element is or contains a mermaid svg
		// Obsidian structure: <div class="mermaid"><svg id="mermaid-xxx">...</svg></div>
		const mermaidSvgs: SVGSVGElement[] = [];

		if (element instanceof HTMLElement) {
			// Find SVGs inside .mermaid containers or SVGs with mermaid id
			const svgs = Array.from(element.querySelectorAll('.mermaid svg, svg[id^="mermaid-"]'));
			mermaidSvgs.push(...svgs as SVGSVGElement[]);

			// Also check if element itself is a mermaid container
			if (element.classList.contains('mermaid')) {
				const svg = element.querySelector('svg');
				if (svg) mermaidSvgs.push(svg);
			}
		}

		for (const svg of mermaidSvgs) {
			if (this.hasZoomContainer(svg)) {
				this.applyCodexMermaidStyle(svg);
				this.processedElements.add(svg);
			} else if (!this.processedElements.has(svg)) {
				this.wrapMermaidWithZoom(svg);
				this.processedElements.add(svg);
			}
		}
	}

	private hasZoomContainer(svg: SVGSVGElement): boolean {
		// Check if SVG or its .mermaid parent is already inside a zoom container
		const mermaidContainer = svg.closest('.mermaid');
		const parent = mermaidContainer?.parentElement || svg.parentElement;
		return parent?.hasClass('mermaid-zoom-content') ?? false;
	}

	private processAllMermaidDiagrams() {
		// Find all mermaid SVGs - Obsidian uses .mermaid container with SVG inside
		const mermaidSvgs = document.querySelectorAll('.mermaid svg, svg[id^="mermaid-"]');
		for (const mermaidSvg of Array.from(mermaidSvgs) as SVGSVGElement[]) {
			if (this.hasZoomContainer(mermaidSvg)) {
				this.applyCodexMermaidStyle(mermaidSvg);
				this.processedElements.add(mermaidSvg);
			} else if (!this.processedElements.has(mermaidSvg)) {
				this.wrapMermaidWithZoom(mermaidSvg);
				this.processedElements.add(mermaidSvg);
			}
		}
	}

	wrapMermaidWithZoom(svg: SVGSVGElement) {
		if (!svg.parentElement) return;

		this.applyCodexMermaidStyle(svg);

		// Find the original .mermaid container
		const mermaidContainer = svg.closest('.mermaid') as HTMLElement;
		const targetParent = mermaidContainer?.parentElement || svg.parentElement;
		const targetElement = mermaidContainer || svg;

		if (!targetParent) return;

		// Get SVG dimensions for initial container sizing
		const initialSvgRect = svg.getBoundingClientRect();
		const initialSvgHeight = initialSvgRect.height || 200;

		// Container height: based on SVG aspect ratio, capped reasonably
		const parentWidth = targetParent.clientWidth || 600;
		const containerHeight = Math.min(initialSvgHeight + 60, parentWidth);

		// Create zoom container
		const container = createDiv('mermaid-zoom-container');
		container.style.height = `${containerHeight}px`;

		// Create content wrapper for transformations
		const contentWrapper = container.createDiv('mermaid-zoom-content');

		// Insert container and move content inside
		targetParent.insertBefore(container, targetElement);
		contentWrapper.appendChild(targetElement);

		// Get SVG original dimensions before any scaling
		const svgRect = svg.getBoundingClientRect();
		const svgOriginalWidth = svgRect.width || svg.clientWidth || 300;
		const svgOriginalHeight = svgRect.height || svg.clientHeight || 200;

		// Initialize zoom state
		const state: ZoomState = {
			scale: this.defaultScale,
			minScale: this.defaultMinScale,
			maxScale: this.defaultMaxScale,
			isDragging: false,
			startX: 0,
			startY: 0,
			translateX: 0,
			translateY: 0,
			svg: svg,
			container: container,
			svgOriginalWidth: svgOriginalWidth,
			svgOriginalHeight: svgOriginalHeight
		};
		this.zoomStates.set(contentWrapper, state);

		// 注册控件和交互，插件卸载时自动清理
		this.register(this.createControls(container, contentWrapper, state));
		this.register(this.addWheelZoom(container, contentWrapper, state));
		this.register(this.addDragPan(container, contentWrapper, state));
		this.register(this.addTouchGestures(container, contentWrapper, state));

		// Fit SVG to container initially
		this.fitToContainer(container, contentWrapper, svg, state);

		// Re-fit on container resize
		this.resizeObserver?.observe(container);
	}

	private applyCodexMermaidStyle(svg: SVGSVGElement) {
		svg.classList.add('mermaid-zoom-svg');
		this.compactDecisionShapes(svg);

		for (const rect of Array.from(svg.querySelectorAll('rect'))) {
			rect.setAttribute('rx', '8');
			rect.setAttribute('ry', '8');
		}
	}

	private compactDecisionShapes(svg: SVGSVGElement) {
		const svgNS = 'http://www.w3.org/2000/svg';
		const polygons = Array.from(svg.querySelectorAll<SVGPolygonElement>('.node polygon'));

		for (const polygon of polygons) {
			if (polygon.points.length < 4 || !polygon.parentElement) continue;

			const label = polygon.parentElement.querySelector<SVGGElement>('.label');
			const labelBox = label?.getBBox();
			const labelTranslate = this.getSvgTranslate(label);
			const horizontalPadding = 20;
			const verticalPadding = 15;
			const fallbackBounds = this.getPolygonBounds(polygon);

			const x = labelBox
				? labelTranslate.x + labelBox.x - horizontalPadding
				: fallbackBounds.x;
			const y = labelBox
				? labelTranslate.y + labelBox.y - verticalPadding
				: fallbackBounds.y;
			const width = labelBox
				? labelBox.width + horizontalPadding * 2
				: fallbackBounds.width;
			const height = labelBox
				? labelBox.height + verticalPadding * 2
				: fallbackBounds.height;

			const rect = document.createElementNS(svgNS, 'rect');
			rect.setAttribute('x', `${x}`);
			rect.setAttribute('y', `${y}`);
			rect.setAttribute('width', `${width}`);
			rect.setAttribute('height', `${height}`);
			rect.setAttribute('rx', '8');
			rect.setAttribute('ry', '8');
			rect.setAttribute('class', `${polygon.getAttribute('class') ?? ''} mermaid-zoom-decision-shape`.trim());

			polygon.replaceWith(rect);
			this.adjustDecisionEdges(svg, rect);
		}

		const oversizedRects = Array.from(svg.querySelectorAll<SVGRectElement>('.node > rect.label-container'));
		for (const rect of oversizedRects) {
			this.compactDecisionRect(svg, rect);
		}

		const nodeRects = Array.from(svg.querySelectorAll<SVGRectElement>('.node > rect.label-container'));
		for (const rect of nodeRects) {
			this.adjustDecisionEdges(svg, rect);
		}
	}

	private getSvgTranslate(element: Element | null): { x: number; y: number } {
		const transform = element?.getAttribute('transform') ?? '';
		const match = transform.match(/translate\(\s*([-0-9.]+)(?:[,\s]+([-0-9.]+))?\s*\)/);
		return {
			x: match ? parseFloat(match[1]) || 0 : 0,
			y: match && match[2] ? parseFloat(match[2]) || 0 : 0
		};
	}

	private getPolygonBounds(polygon: SVGPolygonElement): { x: number; y: number; width: number; height: number } {
		const points = Array.from(polygon.points);
		const xs = points.map((point) => point.x);
		const ys = points.map((point) => point.y);
		const minX = Math.min(...xs);
		const maxX = Math.max(...xs);
		const minY = Math.min(...ys);
		const maxY = Math.max(...ys);

		return {
			x: minX,
			y: minY,
			width: maxX - minX,
			height: maxY - minY
		};
	}

	private compactDecisionRect(svg: SVGSVGElement, rect: SVGRectElement) {
		const node = rect.parentElement;
		const label = node?.querySelector<SVGGElement>('.label');
		const labelBox = label?.getBBox();
		if (!labelBox || !label) return;

		const labelTranslate = this.getSvgTranslate(label);
		const horizontalPadding = 20;
		const verticalPadding = 15;
		const target = {
			x: labelTranslate.x + labelBox.x - horizontalPadding,
			y: labelTranslate.y + labelBox.y - verticalPadding,
			width: labelBox.width + horizontalPadding * 2,
			height: labelBox.height + verticalPadding * 2
		};
		const currentHeight = parseFloat(rect.getAttribute('height') ?? '0');
		const isAlreadyDecision = rect.classList.contains('mermaid-zoom-decision-shape');
		if (currentHeight <= target.height * 1.4 && !isAlreadyDecision) return;

		rect.setAttribute('x', `${target.x}`);
		rect.setAttribute('y', `${target.y}`);
		rect.setAttribute('width', `${target.width}`);
		rect.setAttribute('height', `${target.height}`);
		rect.classList.add('mermaid-zoom-decision-shape');
		this.adjustDecisionEdges(svg, rect);
	}

	private adjustDecisionEdges(svg: SVGSVGElement, rect: SVGRectElement) {
		const node = rect.parentElement;
		const nodeKey = this.getMermaidNodeKey(node);
		if (!node || !nodeKey) return;

		const nodeTranslate = this.getSvgTranslate(node);
		const bounds = {
			x: nodeTranslate.x + (parseFloat(rect.getAttribute('x') ?? '0') || 0),
			y: nodeTranslate.y + (parseFloat(rect.getAttribute('y') ?? '0') || 0),
			width: parseFloat(rect.getAttribute('width') ?? '0') || 0,
			height: parseFloat(rect.getAttribute('height') ?? '0') || 0
		};
		if (bounds.width <= 0 || bounds.height <= 0) return;

		const paths = Array.from(svg.querySelectorAll<SVGPathElement>('path.flowchart-link'));
		for (const path of paths) {
			if (this.isEdgeTarget(path, nodeKey)) {
				this.adjustEdgeEndpoint(path, bounds, 'end');
			} else if (this.isEdgeSource(path, nodeKey)) {
				this.adjustEdgeEndpoint(path, bounds, 'start');
			}
		}
	}

	private getMermaidNodeKey(node: Element | null): string | null {
		const id = node?.id ?? '';
		const match = id.match(/^flowchart-(.+)-\d+$/);
		return match?.[1] ?? null;
	}

	private isEdgeSource(path: SVGPathElement, nodeKey: string): boolean {
		return path.id.startsWith(`L_${nodeKey}_`);
	}

	private isEdgeTarget(path: SVGPathElement, nodeKey: string): boolean {
		return new RegExp(`^L_.+_${this.escapeRegExp(nodeKey)}_\\d+$`).test(path.id);
	}

	private escapeRegExp(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	private adjustEdgeEndpoint(
		path: SVGPathElement,
		bounds: { x: number; y: number; width: number; height: number },
		position: 'start' | 'end'
	) {
		const coordinates = this.getPathCoordinates(path);
		if (coordinates.length < 2) return;

		const endpointIndex = position === 'start' ? 0 : coordinates.length - 1;
		const neighborIndex = position === 'start' ? 1 : coordinates.length - 2;
		const endpoint = this.getRectConnectionPoint(bounds, coordinates[neighborIndex], position === 'end' ? 7 : 0);
		const d = path.getAttribute('d') ?? '';
		path.setAttribute('d', this.replacePathCoordinate(d, endpointIndex, endpoint));
	}

	private getPathCoordinates(path: SVGPathElement): Array<{ x: number; y: number }> {
		const d = path.getAttribute('d') ?? '';
		const coordinateRegex = /(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g;
		return Array.from(d.matchAll(coordinateRegex)).map((match) => ({
			x: parseFloat(match[1]),
			y: parseFloat(match[2])
		}));
	}

	private getRectConnectionPoint(
		bounds: { x: number; y: number; width: number; height: number },
		neighbor: { x: number; y: number },
		offset: number
	): { x: number; y: number } {
		const centerX = bounds.x + bounds.width / 2;
		const centerY = bounds.y + bounds.height / 2;
		const dx = neighbor.x - centerX;
		const dy = neighbor.y - centerY;
		const halfWidth = bounds.width / 2;
		const halfHeight = bounds.height / 2;

		if (dx === 0 && dy === 0) {
			return { x: centerX, y: centerY };
		}

		const tx = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
		const ty = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
		const t = Math.min(tx, ty);
		const distance = Math.hypot(dx, dy);
		const offsetRatio = distance === 0 ? 0 : offset / distance;

		return {
			x: centerX + dx * (t + offsetRatio),
			y: centerY + dy * (t + offsetRatio)
		};
	}

	private replacePathCoordinate(d: string, coordinateIndex: number, point: { x: number; y: number }): string {
		let index = 0;
		return d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (match) => {
			if (index++ !== coordinateIndex) return match;
			return `${this.formatSvgNumber(point.x)},${this.formatSvgNumber(point.y)}`;
		});
	}

	private formatSvgNumber(value: number): string {
		return `${Math.round(value * 1000) / 1000}`;
	}

	private fitToContainer(container: HTMLElement, contentWrapper: HTMLElement, svg: SVGSVGElement, state: ZoomState) {
		// 零值保护：容器或 SVG 尺寸为零时跳过，避免产生无效缩放
		if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
		if (state.svgOriginalWidth <= 0 || state.svgOriginalHeight <= 0) return;

		// 从实际渲染样式中获取内边距，避免硬编码 1em=16px 的假设偏差
		const computedStyle = getComputedStyle(container);
		const paddingLeft = parseFloat(computedStyle.paddingLeft) || 0;
		const paddingRight = parseFloat(computedStyle.paddingRight) || 0;
		const paddingTop = parseFloat(computedStyle.paddingTop) || 0;
		const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0;

		// 计算可用空间（基于实际内边距）
		const availableWidth = container.clientWidth - paddingLeft - paddingRight;
		const availableHeight = container.clientHeight - paddingTop - paddingBottom;

		// 使用保存的原始 SVG 尺寸
		const svgWidth = state.svgOriginalWidth;
		const svgHeight = state.svgOriginalHeight;

		// 计算适配缩放比例
		const scaleX = availableWidth / svgWidth;
		const scaleY = availableHeight / svgHeight;
		const fitScale = Math.min(scaleX, scaleY, 1); // 不超过 100%

		// 基于容器全宽居中（与全屏模态框一致），减去左内边距得到 translateX
		const scaledWidth = svgWidth * fitScale;
		const scaledHeight = svgHeight * fitScale;
		const centerX = (container.clientWidth - scaledWidth) / 2 - paddingLeft;
		const centerY = (container.clientHeight - scaledHeight) / 2 - paddingTop;

		// 应用缩放和居中
		state.scale = fitScale;
		state.translateX = centerX;
		state.translateY = Math.max(0, centerY);
		this.updateTransform(contentWrapper, state);
	}

	private openFullscreenModal(state: ZoomState) {
		// Create modal overlay
		const modal = document.createElement('div');
		modal.className = 'mermaid-zoom-modal';

		// Create header with close button
		const header = document.createElement('div');
		header.className = 'mermaid-zoom-modal-header';

		// Close button
		const closeBtn = document.createElement('button');
		closeBtn.className = 'mermaid-zoom-modal-close';
		closeBtn.textContent = '✕';
		header.appendChild(closeBtn);

		// Create content area
		const content = document.createElement('div');
		content.className = 'mermaid-zoom-modal-content';

		// Create zoom container inside modal
		const modalZoomContainer = document.createElement('div');
		modalZoomContainer.className = 'mermaid-zoom-modal-zoom-container';

		// Create content wrapper for transformations
		const modalContentWrapper = document.createElement('div');
		modalContentWrapper.className = 'mermaid-zoom-modal-wrapper';

		// Clone the SVG
		const svgClone = state.svg.cloneNode(true) as SVGSVGElement;
		this.applyCodexMermaidStyle(svgClone);
		modalContentWrapper.appendChild(svgClone);
		modalZoomContainer.appendChild(modalContentWrapper);
		content.appendChild(modalZoomContainer);

		// Create modal controls
		const controls = document.createElement('div');
		controls.className = 'mermaid-zoom-modal-controls';

		// Modal zoom state
		const modalState: ZoomState = {
			scale: 1,
			minScale: this.defaultMinScale,
			maxScale: this.defaultMaxScale,
			isDragging: false,
			startX: 0,
			startY: 0,
			translateX: 0,
			translateY: 0,
			svg: svgClone,
			container: modalZoomContainer,
			svgOriginalWidth: state.svgOriginalWidth,
			svgOriginalHeight: state.svgOriginalHeight
		};

		// Add zoom buttons
		const zoomInBtn = document.createElement('button');
		zoomInBtn.className = 'mermaid-zoom-btn';
		zoomInBtn.textContent = '+';
		this.styleButton(zoomInBtn);
		zoomInBtn.addEventListener('click', () => this.zoom(modalContentWrapper, modalState, 1.2));

		const zoomOutBtn = document.createElement('button');
		zoomOutBtn.className = 'mermaid-zoom-btn';
		zoomOutBtn.textContent = '-';
		this.styleButton(zoomOutBtn);
		zoomOutBtn.addEventListener('click', () => this.zoom(modalContentWrapper, modalState, 0.8));

		const resetBtn = document.createElement('button');
		resetBtn.className = 'mermaid-zoom-btn';
		resetBtn.textContent = '⟲';
		this.styleButton(resetBtn);
		resetBtn.addEventListener('click', () => {
			this.fitToContainerModal(modalZoomContainer, modalContentWrapper, modalState);
		});

		// Scale indicator
		const scaleIndicator = document.createElement('span');
		scaleIndicator.className = 'mermaid-zoom-scale';
		modalState.scaleIndicator = scaleIndicator;

		controls.appendChild(zoomInBtn);
		controls.appendChild(zoomOutBtn);
		controls.appendChild(resetBtn);
		controls.appendChild(scaleIndicator);
		content.appendChild(controls);

		modal.appendChild(header);
		modal.appendChild(content);

		// 注册模态框交互，收集清理函数以便关闭时移除
		const modalCleanupFns: (() => void)[] = [];
		modalCleanupFns.push(this.addWheelZoom(modalZoomContainer, modalContentWrapper, modalState));
		modalCleanupFns.push(this.addDragPan(modalZoomContainer, modalContentWrapper, modalState));
		modalCleanupFns.push(this.addTouchGestures(modalZoomContainer, modalContentWrapper, modalState));

		// 关闭模态框
		const closeModal = () => {
			// 清理模态框的所有事件监听器
			for (const cleanup of modalCleanupFns) {
				cleanup();
			}
			modal.remove();
			document.removeEventListener('keydown', handleKeydown);
		};

		// 处理 ESC 键
		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				closeModal();
			}
		};
		document.addEventListener('keydown', handleKeydown);

		// 关闭按钮点击
		closeBtn.addEventListener('click', closeModal);

		// 将模态框添加到文档
		document.body.appendChild(modal);

		// 模态框可见后适配容器
		requestAnimationFrame(() => {
			this.fitToContainerModal(modalZoomContainer, modalContentWrapper, modalState);
		});
	}

	private fitToContainerModal(container: HTMLElement, contentWrapper: HTMLElement, state: ZoomState) {
		// 零值保护：模态框容器或 SVG 尺寸为零时跳过
		if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
		if (state.svgOriginalWidth <= 0 || state.svgOriginalHeight <= 0) return;

		// 计算可用空间
		const padding = 40;
		const availableWidth = container.clientWidth - padding * 2;
		const availableHeight = container.clientHeight - padding * 2;

		// Use saved original SVG dimensions
		const svgWidth = state.svgOriginalWidth;
		const svgHeight = state.svgOriginalHeight;

		// Calculate scale to fit
		const scaleX = availableWidth / svgWidth;
		const scaleY = availableHeight / svgHeight;
		const fitScale = Math.min(scaleX, scaleY, 2); // Allow up to 200% in modal

		// Center the SVG
		const scaledWidth = svgWidth * fitScale;
		const scaledHeight = svgHeight * fitScale;
		const centerX = (container.clientWidth - scaledWidth) / 2;
		const centerY = (container.clientHeight - scaledHeight) / 2;

		// Apply the scale and center
		state.scale = fitScale;
		state.translateX = centerX;
		state.translateY = centerY;
		this.updateTransform(contentWrapper, state);
	}

	private createControls(container: HTMLElement, contentWrapper: HTMLElement, state: ZoomState): () => void {
		const controls = container.createDiv('mermaid-zoom-controls');

		// Zoom in button
		const zoomInBtn = controls.createEl('button', {
			text: '+',
			cls: 'mermaid-zoom-btn'
		});
		this.styleButton(zoomInBtn);
		zoomInBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.zoom(contentWrapper, state, 1.2);
		});

		// Zoom out button
		const zoomOutBtn = controls.createEl('button', {
			text: '-',
			cls: 'mermaid-zoom-btn'
		});
		this.styleButton(zoomOutBtn);
		zoomOutBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.zoom(contentWrapper, state, 0.8);
		});

		// Reset button
		const resetBtn = controls.createEl('button', {
			text: '⟲',
			cls: 'mermaid-zoom-btn'
		});
		this.styleButton(resetBtn);
		resetBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.resetZoom(contentWrapper, state);
		});

		// Scale indicator
		const scaleIndicator = controls.createEl('span', {
			cls: 'mermaid-zoom-scale'
		});
		state.scaleIndicator = scaleIndicator;
		this.updateTransform(contentWrapper, state);

		// Fullscreen toggle button
		const fullscreenBtn = controls.createEl('button', {
			cls: 'mermaid-zoom-btn mermaid-fullscreen-btn'
		});

		// Create SVG icon
		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('width', '24');
		svg.setAttribute('height', '24');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '1');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');

		const polyline1 = document.createElementNS(svgNS, 'polyline');
		polyline1.setAttribute('points', '1,10 1,15 6,15');
		svg.appendChild(polyline1);

		const polyline2 = document.createElementNS(svgNS, 'polyline');
		polyline2.setAttribute('points', '15,10 15,15 10,15');
		svg.appendChild(polyline2);

		const polyline3 = document.createElementNS(svgNS, 'polyline');
		polyline3.setAttribute('points', '1,6 1,1 6,1');
		svg.appendChild(polyline3);

		const polyline4 = document.createElementNS(svgNS, 'polyline');
		polyline4.setAttribute('points', '15,6 15,1 10,1');
		svg.appendChild(polyline4);

		fullscreenBtn.appendChild(svg);
		this.styleButton(fullscreenBtn);
		fullscreenBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openFullscreenModal(state);
		});

		// 添加调整大小手柄，并返回清理函数
		return this.addResizeHandles(container, contentWrapper, state);
	}

	private styleButton(btn: HTMLButtonElement) {
		btn.type = 'button';
		btn.classList.add('mermaid-zoom-btn');
	}

	private addResizeHandles(container: HTMLElement, contentWrapper: HTMLElement, state: ZoomState): () => void {
		// 光标类型到 CSS 类名的映射
		const cursorClassMap: Record<string, string> = {
			'nwse-resize': 'mermaid-zoom-resizing-nwse',
			'nesw-resize': 'mermaid-zoom-resizing-nesw',
			'ns-resize': 'mermaid-zoom-resizing-ns',
			'ew-resize': 'mermaid-zoom-resizing-ew'
		};

		// 定义调整大小手柄：4个角 + 4条边
		const handles = [
			{ position: 'top-left', cursor: 'nwse-resize', style: 'top: 0; left: 0; width: 12px; height: 12px;' },
			{ position: 'top-right', cursor: 'nesw-resize', style: 'top: 0; right: 0; width: 12px; height: 12px;' },
			{ position: 'bottom-left', cursor: 'nesw-resize', style: 'bottom: 0; left: 0; width: 12px; height: 12px;' },
			{ position: 'bottom-right', cursor: 'nwse-resize', style: 'bottom: 0; right: 0; width: 12px; height: 12px;' },
			{ position: 'top', cursor: 'ns-resize', style: 'top: 0; left: 12px; right: 12px; height: 6px;' },
			{ position: 'bottom', cursor: 'ns-resize', style: 'bottom: 0; left: 12px; right: 12px; height: 6px;' },
			{ position: 'left', cursor: 'ew-resize', style: 'top: 12px; bottom: 12px; left: 0; width: 6px;' },
			{ position: 'right', cursor: 'ew-resize', style: 'top: 12px; bottom: 12px; right: 0; width: 6px;' },
		];

		// 收集所有 document 级监听器引用，用于统一清理
		const documentListeners: Array<{ type: string; fn: EventListener }> = [];

		// 获取初始边距值
		let currentMarginLeft = 0;
		let currentMarginTop = 0;

		handles.forEach(({ position, cursor, style }) => {
			const handle = container.createDiv(`mermaid-resize-${position}`);
			handle.style.cssText = `
				position: absolute;
				${style}
				cursor: ${cursor};
				z-index: 50;
			`;

			const resizeClass = cursorClassMap[cursor];
			let isResizing = false;
			let startX = 0;
			let startY = 0;
			let startWidth = 0;
			let startHeight = 0;
			let startMarginLeft = 0;
			let startMarginTop = 0;

			const onMouseDown = (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
				isResizing = true;
				startX = e.clientX;
				startY = e.clientY;
				startWidth = container.offsetWidth;
				startHeight = container.offsetHeight;
				startMarginLeft = currentMarginLeft;
				startMarginTop = currentMarginTop;
				document.body.addClass(resizeClass);
			};

			const onMouseMove = (e: MouseEvent) => {
				if (!isResizing) return;
				e.preventDefault();

				const deltaX = e.clientX - startX;
				const deltaY = e.clientY - startY;

				let newWidth = startWidth;
				let newHeight = startHeight;
				let newMarginLeft = startMarginLeft;
				let newMarginTop = startMarginTop;

				// 水平方向调整
				if (position.includes('right')) {
					newWidth = Math.max(150, startWidth + deltaX);
				} else if (position.includes('left')) {
					// 使用负边距向左扩展
					const widthDelta = -deltaX;
					newWidth = Math.max(150, startWidth + widthDelta);
					if (newWidth > 150) {
						newMarginLeft = startMarginLeft + deltaX;
					}
				}

				// 垂直方向调整
				if (position.includes('bottom')) {
					newHeight = Math.max(100, startHeight + deltaY);
				} else if (position.includes('top')) {
					// 使用负边距向上扩展
					const heightDelta = -deltaY;
					newHeight = Math.max(100, startHeight + heightDelta);
					if (newHeight > 100) {
						newMarginTop = startMarginTop + deltaY;
					}
				}

				container.style.width = `${newWidth}px`;
				container.style.height = `${newHeight}px`;
				container.style.marginLeft = `${newMarginLeft}px`;
				container.style.marginTop = `${newMarginTop}px`;
				currentMarginLeft = newMarginLeft;
				currentMarginTop = newMarginTop;
			};

			const onMouseUp = () => {
				if (!isResizing) return;
				isResizing = false;
				document.body.removeClass(resizeClass);
				this.resetZoom(contentWrapper, state);
			};

			handle.addEventListener('mousedown', onMouseDown);
			document.addEventListener('mousemove', onMouseMove);
			document.addEventListener('mouseup', onMouseUp);
			documentListeners.push(
				{ type: 'mousemove', fn: onMouseMove },
				{ type: 'mouseup', fn: onMouseUp }
			);
		});

		// 返回清理函数，批量移除所有 document 级监听器
		return () => {
			for (const { type, fn } of documentListeners) {
				document.removeEventListener(type, fn);
			}
		};
	}

	private addWheelZoom(container: HTMLElement, contentWrapper: HTMLElement, state: ZoomState): () => void {
		const wheelHandler = (e: WheelEvent) => {
			e.preventDefault();

			const rect = container.getBoundingClientRect();
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;

			const delta = e.deltaY > 0 ? 0.9 : 1.1;
			const oldScale = state.scale;
			let newScale = oldScale * delta;
			newScale = Math.max(state.minScale, Math.min(state.maxScale, newScale));

			if (newScale !== oldScale) {
				// 根据鼠标位置调整缩放平移
				const scaleRatio = newScale / oldScale;
				state.translateX = mouseX - (mouseX - state.translateX) * scaleRatio;
				state.translateY = mouseY - (mouseY - state.translateY) * scaleRatio;
				state.scale = newScale;

				this.updateTransform(contentWrapper, state);
			}
		};
		container.addEventListener('wheel', wheelHandler, { passive: false });

		return () => container.removeEventListener('wheel', wheelHandler);
	}

	private addDragPan(container: HTMLElement, contentWrapper: HTMLElement, state: ZoomState): () => void {
		// 设置初始光标状态
		contentWrapper.classList.add('mermaid-zoom-content');

		container.addEventListener('mousedown', (e) => {
			if (e.button === 0) { // 左键按下
				state.isDragging = true;
				state.startX = e.clientX - state.translateX;
				state.startY = e.clientY - state.translateY;
				contentWrapper.addClass('dragging');
			}
		});

		const onMouseMove = (e: MouseEvent) => {
			if (state.isDragging) {
				e.preventDefault();
				state.translateX = e.clientX - state.startX;
				state.translateY = e.clientY - state.startY;
				this.updateTransform(contentWrapper, state);
			}
		};

		const onMouseUp = () => {
			if (state.isDragging) {
				state.isDragging = false;
				contentWrapper.removeClass('dragging');
			}
		};

		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);

		// 返回清理函数，移除 document 级监听器
		return () => {
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
		};
	}

	private addTouchGestures(container: HTMLElement, contentWrapper: HTMLElement, state: ZoomState): () => void {
		let initialDistance = 0;
		let initialScale = 1;

		const onTouchStart = (e: TouchEvent) => {
			if (e.touches.length === 2) {
				// 双指缩放
				const touch1 = e.touches[0];
				const touch2 = e.touches[1];
				initialDistance = Math.hypot(
					touch2.clientX - touch1.clientX,
					touch2.clientY - touch1.clientY
				);
				initialScale = state.scale;
			} else if (e.touches.length === 1) {
				// 单指拖拽
				state.isDragging = true;
				state.startX = e.touches[0].clientX - state.translateX;
				state.startY = e.touches[0].clientY - state.translateY;
			}
		};

		const onTouchMove = (e: TouchEvent) => {
			e.preventDefault();

			if (e.touches.length === 2) {
				// 双指缩放
				const touch1 = e.touches[0];
				const touch2 = e.touches[1];
				const currentDistance = Math.hypot(
					touch2.clientX - touch1.clientX,
					touch2.clientY - touch1.clientY
				);

				const scaleRatio = currentDistance / initialDistance;
				let newScale = initialScale * scaleRatio;
				newScale = Math.max(state.minScale, Math.min(state.maxScale, newScale));

				state.scale = newScale;
				this.updateTransform(contentWrapper, state);
			} else if (e.touches.length === 1 && state.isDragging) {
				// 单指拖拽
				state.translateX = e.touches[0].clientX - state.startX;
				state.translateY = e.touches[0].clientY - state.startY;
				this.updateTransform(contentWrapper, state);
			}
		};

		const onTouchEnd = () => {
			state.isDragging = false;
		};

		container.addEventListener('touchstart', onTouchStart);
		container.addEventListener('touchmove', onTouchMove, { passive: false });
		container.addEventListener('touchend', onTouchEnd);

		return () => {
			container.removeEventListener('touchstart', onTouchStart);
			container.removeEventListener('touchmove', onTouchMove);
			container.removeEventListener('touchend', onTouchEnd);
		};
	}

	private zoom(contentWrapper: HTMLElement, state: ZoomState, factor: number) {
		let newScale = state.scale * factor;
		newScale = Math.max(state.minScale, Math.min(state.maxScale, newScale));

		// Center the zoom
		const container = contentWrapper.parentElement;
		if (container) {
			const rect = container.getBoundingClientRect();
			const centerX = rect.width / 2;
			const centerY = rect.height / 2;
			const scaleRatio = newScale / state.scale;

			state.translateX = centerX - (centerX - state.translateX) * scaleRatio;
			state.translateY = centerY - (centerY - state.translateY) * scaleRatio;
		}

		state.scale = newScale;
		this.updateTransform(contentWrapper, state);
	}

	private resetZoom(contentWrapper: HTMLElement, state: ZoomState) {
		// Fit to container instead of just resetting to 100%
		this.fitToContainer(state.container, contentWrapper, state.svg, state);
	}

	private updateTransform(contentWrapper: HTMLElement, state: ZoomState) {
		contentWrapper.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;

		// Update scale indicator
		if (state.scaleIndicator) {
			state.scaleIndicator.textContent = `${Math.round(state.scale * 100)}%`;
		}
	}

	onunload() {
		console.debug('Unloading Mermaid Zoom plugin');

		// Disconnect observers
		if (this.mutationObserver) {
			this.mutationObserver.disconnect();
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
		}

		this.zoomStates.clear();
		this.processedElements = new WeakSet();
	}
}
