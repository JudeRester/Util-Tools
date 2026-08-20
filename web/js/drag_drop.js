/**
 * 공통 마우스 드래그 앤 드롭(Drag & Drop) 핸들러 모듈
 */

function attachListDragAndDrop(containerId, onReorder) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const items = container.querySelectorAll('.manage-item');
    let draggedIndex = null;

    items.forEach(item => {
        item.addEventListener('dragstart', (e) => {
            draggedIndex = parseInt(item.getAttribute('data-index'), 10);
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(draggedIndex));
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const target = e.currentTarget;
            if (target && !target.classList.contains('dragging')) {
                target.classList.add('drag-over');
            }
        });

        item.addEventListener('dragleave', (e) => {
            e.currentTarget.classList.remove('drag-over');
        });

        item.addEventListener('drop', (e) => {
            e.preventDefault();
            e.currentTarget.classList.remove('drag-over');
            const targetIndex = parseInt(e.currentTarget.getAttribute('data-index'), 10);
            if (draggedIndex !== null && !isNaN(draggedIndex) && !isNaN(targetIndex) && draggedIndex !== targetIndex) {
                onReorder(draggedIndex, targetIndex);
            }
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            container.querySelectorAll('.manage-item').forEach(el => el.classList.remove('drag-over'));
            draggedIndex = null;
        });
    });
}
