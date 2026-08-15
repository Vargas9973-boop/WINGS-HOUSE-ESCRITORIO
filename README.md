# Wings House — Sistema Administrativo

Aplicación de escritorio (Electron) para la gestión completa de Wings House:
Ventas (POS), Catálogo y Promociones, Inventarios, Merma, Costos y Asistencia.
Toda la información se guarda en una base de datos SQLite local, incluida cada
venta y su ticket, aunque la impresión física falle.

## 1. Instalación

Requisitos: [Node.js](https://nodejs.org) 18 o superior. **No necesitas
Visual Studio, Build Tools ni ningún compilador de C++.**

```bash
npm install
npm start
```

La base de datos usa [`sql.js`](https://sql.js.org) (SQLite compilado a
WebAssembly), que es JavaScript/WASM puro: `npm install` solo descarga
archivos, no compila nada. Si en algún momento ves errores de `node-gyp`
o `Visual Studio` durante `npm install`, es señal de que quedó una
instalación anterior con `better-sqlite3` — borra `node_modules` y
`package-lock.json` y vuelve a correr `npm install`.

La base de datos se crea automáticamente en la carpeta de datos de usuario
del sistema (por ejemplo `%APPDATA%/wings-house-admin` en Windows, o
`~/Library/Application Support/wings-house-admin` en macOS) como el archivo
`wingshouse.sqlite`, con el catálogo de productos ya cargado desde
`MENU_COMESTIBLES.jpeg` y `MENU_BEBIDAS.jpeg`.

## 2. Cuentas y roles

La app abre con una pantalla de inicio de sesión. Cuentas creadas por defecto
(cámbialas desde **Cuentas** en cuanto entres como administrador):

| Usuario    | Contraseña   | Rol            | Acceso                                   |
|------------|--------------|----------------|-------------------------------------------|
| `admin`    | `admin123`   | Administrador  | Todos los módulos                         |
| `cajero1`  | `cajero123`  | Cajero         | Ventas y Comandas                         |
| `cajero2`  | `cajero123`  | Cajero         | Ventas y Comandas                         |
| `empleado` | `empleado123`| Empleado       | Registrar su entrada/salida en Asistencia |

## 3. Módulos

- **Ventas**: catálogo con categorías (Alitas, Boneless, Hot-Dogs,
  Hamburguesas, Papas, Acompañantes, Bebidas, Extras), franja fija de
  **Promociones** arriba del catálogo para agregarlas con un clic, carrito,
  descuento automático a empleados, cobro (efectivo/tarjeta/transferencia),
  cálculo de cambio, guardado del ticket en base de datos e impresión.
- **Comandas**: mapa de mesas (libre/ocupada). Al abrir una mesa se lleva el
  consumo en tiempo real directo en la base de datos; al pedir la cuenta se
  cobra y se imprime **solo el ticket de esa mesa**.
- **Catálogo**: alta, edición y baja de productos y de promociones (las
  promociones creadas aquí aparecen automáticamente en Ventas y Comandas).
- **Inventarios**: control de existencias de insumos, mínimos y costo por
  unidad.
- **Merma**: registra bajas de inventario por caducidad, error, accidente,
  etc. Descuenta automáticamente del stock y calcula el costo.
- **Costos**: rentabilidad por rango de fechas (ventas − merma − costos),
  gráfica de ventas por día, productos más vendidos y registro de gastos
  fijos/variables.
- **Reportes**: resumen diario/semanal/mensual/personalizado, exportación a
  CSV (ventas, productos, gastos, merma, asistencia, nómina) y un reporte
  profesional completo listo para imprimir o guardar como PDF.
- **Asistencia**: registro de entrada/salida, alta de empleados con
  **salario semanal y bono**, y una pestaña de **Nómina semanal** donde
  marcas si cada empleado acreditó su bono esa semana (el total se calcula
  solo).
- **Cuentas** (solo Administrador): alta, edición y desactivación de
  usuarios y roles.
- **Ajustes**: nombre, dirección y teléfono del negocio (se imprimen en el
  ticket), porcentaje de descuento a empleados, número de mesas para
  Comandas, e impresora térmica a usar.

## 4. Configurar la impresora de tickets (equipo externo)

1. Conecta e instala el driver de tu impresora térmica (USB, red o
   Bluetooth) como una impresora normal del sistema operativo — igual que
   cualquier impresora de Windows/macOS/Linux.
2. Abre el módulo **Ajustes** dentro de la app y selecciona esa impresora
   en la lista (se detecta automáticamente).
3. Guarda los ajustes. A partir de ese momento, cada venta se imprime en
   silencio en esa impresora al confirmar el cobro.
4. Si prefieres elegir la impresora manualmente en cada venta (por ejemplo
   si usas varias), deja la opción en "Preguntar cada vez": aparecerá el
   diálogo de impresión del sistema.

**Importante:** la venta y sus artículos siempre se guardan en la base de
datos al confirmar el cobro, imprima o no correctamente el ticket. Si la
impresora falla, la app lo avisa pero la venta ya quedó registrada.

## 5. Personalización de colores

Los módulos administrativos comparten la paleta de `common.css`
(`--brand-orange`, `--brand-red`, `--brand-yellow`, etc.) tomada
directamente de `logo.png`. El módulo de Ventas usa las mismas variables en
`sales.css`. Puedes modificar cualquier color, tamaño o sección libremente
en esos archivos sin afectar la lógica de negocio (`*-renderer.js`).

## 6. Estructura del proyecto

```
main.js              Proceso principal: ventanas, navegación, IPC y auth
db.js                 Motor sql.js (SQLite/WASM), esquema y datos semilla
preload.js            Puente seguro de API (window.db, window.auth, etc.)
ticket-preload.js     Puente exclusivo de la ventana de impresión de tickets
report-preload.js     Puente exclusivo de la ventana de reporte imprimible
common.css/js         Sistema visual, utilidades y control de sesión
login.*                Pantalla de inicio de sesión
index.html            Carrusel principal (filtrado por rol)
sales.*                Módulo de Ventas (POS)
comandas.*             Módulo de Comandas (mesas)
catalog.*              Módulo de Catálogo y Promociones
inventory.*             Módulo de Inventarios
waste.*                 Módulo de Merma
costs.*                  Módulo de Costos
reports.*                Módulo de Reportes y Exportación
report-print.*           Plantilla del reporte imprimible
attendance.*             Módulo de Asistencia, Empleados y Nómina
accounts.*                Módulo de Cuentas (usuarios y roles)
settings.*                 Módulo de Ajustes
ticket.*                    Plantilla de impresión del ticket térmico
```
