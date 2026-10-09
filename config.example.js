// Configuración de BioPanel / SenseFace
// Copia este archivo como config.js y pon tus datos. config.js no se sube al repositorio.
module.exports = {
  PORT: 8088,
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://postgres:TU_CLAVE@localhost:5432/senseface',
  TIMEZONE: -4,                 // Bolivia (UTC-4)

  // Administrador inicial (se crea solo la primera vez). Cambia la clave después de entrar.
  ADMIN_EMAIL: 'malvarez@sirtsc.com',
  ADMIN_PASSWORD: 'Martin0411.',

  // Segundos sin contacto para considerar un equipo "fuera de línea"
  ONLINE_SECONDS: 60,

  // Contacto de soporte que ven los clientes en "Mi empresa" (opcional)
  SOPORTE: { nombre: 'Soporte BioPanel', telefono: '+591 70000000', email: 'soporte@ejemplo.com' },
};
