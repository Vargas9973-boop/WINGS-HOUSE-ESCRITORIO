function fmt(n) {
    return `$${(Number(n) || 0).toFixed(2)}`;
}

function paymentLabel(method) {
    return {
        efectivo: 'Efectivo',
        tarjeta: 'Tarjeta',
        transferencia: 'Transferencia',
        credito: 'Crédito',
        credito_nomina: 'Crédito Nómina',
        beneficio_empleado: 'Beneficio Empleado'
    }[method] || method || '';
}

function clientLabel(type) {
    return type === 'employee'
        ? 'Empleado / Interno'
        : 'Público General';
}

function deliveryStatusLabel(status) {
    return {
        pendiente: 'Pendiente',
        en_camino: 'En camino',
        entregado: 'Entregado'
    }[status] || 'Pendiente';
}

function shortId(id) {
    if (id === null || id === undefined) return '';
    return String(id);
}

function formatDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const datePart = new Intl.DateTimeFormat('es-MX', {
        timeZone: 'America/Mexico_City',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    }).format(d);
    const timePart = new Intl.DateTimeFormat('es-MX', {
        timeZone: 'America/Mexico_City',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    }).format(d).toUpperCase();
    return `${datePart} ${timePart}`;
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[c]));
}

function applyPageWidth(widthMm) {
    let styleEl = document.getElementById('dynamic-page-size');

    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'dynamic-page-size';
        document.head.appendChild(styleEl);
    }

    styleEl.textContent = `
        @page { size: ${widthMm}mm auto; margin: 0; }
        body { width: ${widthMm}mm; }
    `;
}

function renderTicket({ sale, settings }) {

    const root = document.getElementById('ticket-root');

    if (!root) {
        throw new Error('No se encontró #ticket-root');
    }

    settings = settings || {};
    sale = sale || {};

    const width = settings.ticket_width === '80' ? '80' : '58';

    root.className = `ticket ticket-${width}`;

    // @page/body en mm reales: sin esto, al imprimir se usa el tamaño de
    // papel por defecto del sistema (normalmente carta) en vez del ancho
    // del rollo térmico configurado, y el contenido sale cortado o con
    // márgenes en blanco enormes.
    applyPageWidth(width === '80' ? 80 : 58);

    const items = Array.isArray(sale.items)
        ? sale.items
        : [];

    const itemsHtml = items.map((item) => {

        const isPromo = item.item_type === 'promo';

        const modifierNames = (item.sale_item_modifiers || [])
            .map((sim) => sim.modifiers?.name)
            .filter(Boolean);
        const modifiersHtml = modifierNames
            .map((name) => `<div class="item-modifier">&gt; ${escapeHtml(name)}</div>`)
            .join('');

        return `
            <div class="item">
                <div class="item-name">
                    <span class="${isPromo ? 'promo-mark' : ''}">
                        ${escapeHtml(item.name || '')}
                    </span>

                    <span>
                        ${fmt(item.subtotal)}
                    </span>
                </div>

                <div class="item-detail">
                    ${Number(item.quantity) || 0}
                    x
                    ${fmt(item.unit_price)}
                </div>

                ${modifiersHtml}
            </div>
        `;

    }).join('');

    const tableHtml = sale.table_number
        ? `
            <div class="row">
                <span>Mesa</span>
                <span>${escapeHtml(sale.table_number)}</span>
            </div>
        `
        : '';

    const discountHtml = `
        <div class="row">
            <span>Descuento</span>
            <span>-${fmt(sale.discount)}</span>
        </div>
    `;

    // --- Domicilio (solo si la venta viene de comanda_set_delivery) ---
    const deliveryHtml = sale.is_delivery
        ? `
            <div class="sep"></div>
            <div class="row">
                <span>Domicilio</span>
                <span class="bold">${escapeHtml(deliveryStatusLabel(sale.delivery_status))}</span>
            </div>
            ${sale.customer_name ? `
                <div class="row">
                    <span>Nombre</span>
                    <span>${escapeHtml(sale.customer_name)}</span>
                </div>
            ` : ''}
            ${sale.customer_phone ? `
                <div class="row">
                    <span>Teléfono</span>
                    <span>${escapeHtml(sale.customer_phone)}</span>
                </div>
            ` : ''}
            ${sale.delivery_address ? `
                <div class="row">
                    <span>Dirección</span>
                    <span>${escapeHtml(sale.delivery_address)}</span>
                </div>
            ` : ''}
            ${sale.driver_name ? `
                <div class="row">
                    <span>Repartidor</span>
                    <span>${escapeHtml(sale.driver_name)}</span>
                </div>
            ` : ''}
        `
        : '';

    const deliveryFeeHtml = sale.is_delivery && Number(sale.delivery_fee) > 0
        ? `
            <div class="row">
                <span>Envío</span>
                <span>${fmt(sale.delivery_fee)}</span>
            </div>
        `
        : '';

    const cashHtml = sale.payment_method === 'efectivo'
        ? `
            <div class="row">
                <span>Recibido</span>
                <span>${fmt(sale.amount_received)}</span>
            </div>

            <div class="row">
                <span>Cambio</span>
                <span>${fmt(sale.change_given)}</span>
            </div>
        `
        : '';

    // --- Sucursal (branch) ---
    const branch = sale.branch || null;
    const businessName = (branch && branch.name) || settings.business_name || 'Wings House';
    const businessAddress = (branch && branch.address) || settings.business_address || '';
    const businessPhone = (branch && branch.phone) || settings.business_phone || '';

    const branchHtml = branch
        ? `
            <div class="row">
                <span>Sucursal</span>
                <span>${escapeHtml(branch.name || '')}</span>
            </div>
        `
        : '';

    // --- Atendió (cajero que cobró) ---
    const employee = sale.employee || null;
    const attendedHtml = employee
        ? `
            <div class="row">
                <span>Atendió</span>
                <span>
                    ${escapeHtml(employee.display_name || employee.username || '')}
                    ${employee.username ? `(${escapeHtml(employee.username)})` : ''}
                    ${employee.id != null ? `- ID: ${escapeHtml(shortId(employee.id))}` : ''}
                </span>
            </div>
        `
        : '';

    // --- Cliente (empleado interno o público general) ---
    const customer = sale.customer || null;
    const customerLabel = customer
        ? `${escapeHtml(customer.display_name || '')} - Empleado / Interno - ID: ${escapeHtml(shortId(customer.id))}`
        : `${clientLabel(sale.client_type)}`;

    // --- Crédito de empleado (solo si el cliente es un empleado interno) ---
    const creditHtml = customer
        ? `
            <div class="sep"></div>
            <div class="row">
                <span>Crédito antes</span>
                <span>${fmt(sale.credit_before)}</span>
            </div>
            <div class="row">
                <span>Crédito usado en esta venta</span>
                <span>${fmt(sale.employeeBenefitUsed)}</span>
            </div>
            <div class="row">
                <span>Crédito disponible después</span>
                <span>${fmt(sale.credit_available_after)}</span>
            </div>
            ${Number(sale.employeeCreditExtra) > 0 ? `
                <div class="row">
                    <span>Crédito semanal generado</span>
                    <span>${fmt(sale.employeeCreditExtra)}</span>
                </div>
            ` : ''}
        `
        : '';

    root.innerHTML = `
        <img
            class="logo"
            src="${escapeHtml(settings.logo_url || 'logo.png')}"
            alt="logo"
        >

        <h1>
            ${escapeHtml(businessName)}
        </h1>

        <div class="biz-line">
            ${escapeHtml(businessAddress)}
        </div>

        <div class="biz-line">
            Tel: ${escapeHtml(businessPhone)}
        </div>

        <div class="sep"></div>

        <div class="row">
            <span>Folio</span>
            <span class="bold">
                ${escapeHtml(sale.folio || '')}
            </span>
        </div>

        <div class="row">
            <span>Fecha</span>
            <span>
                ${escapeHtml(formatDate(sale.created_at))}
            </span>
        </div>

        ${branchHtml}

        ${tableHtml}

        ${deliveryHtml}

        ${attendedHtml}

        <div class="row">
            <span>Cliente</span>
            <span>
                ${customerLabel}
            </span>
        </div>

        <div class="sep"></div>

        <div class="items">
            ${itemsHtml}
        </div>

        <div class="sep"></div>

        <div class="totals">

            <div class="row">
                <span>Subtotal</span>
                <span>
                    ${fmt(sale.subtotal)}
                </span>
            </div>

            ${deliveryFeeHtml}

            ${discountHtml}

            <div class="row grand">
                <span>TOTAL</span>
                <span>
                    ${fmt(sale.total)}
                </span>
            </div>

            <div class="row">
                <span>Pago</span>
                <span>
                    ${paymentLabel(sale.payment_method)}
                </span>
            </div>

            ${cashHtml}

            ${creditHtml}

        </div>

        <div class="footer">
            <div>¡Saber comer es saber vivir!</div>
            <div>Gracias por su compra</div>
        </div>
    `;
}


// ==========================================================================
// DATOS DEL TICKET
// ==========================================================================

window.ticketAPI.onTicketData((payload) => {

    try {

        renderTicket(payload);

        // Esperamos a que el navegador termine de pintar:
        requestAnimationFrame(() => {

            requestAnimationFrame(() => {

                setTimeout(() => {

                    try {

                        window.ticketAPI.notifyRendered();

                    } catch (error) {

                        console.error(
                            'Error enviando ticket-rendered:',
                            error
                        );

                    }

                }, 300);

            });

        });

    } catch (error) {

        console.error(
            'Error renderizando ticket:',
            error
        );

        // Avisar igualmente al proceso principal
        // para que no quede esperando hasta timeout.
        try {
            window.ticketAPI.notifyRendered();
        } catch (_) {}
    }

});
