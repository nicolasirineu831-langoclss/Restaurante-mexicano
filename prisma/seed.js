import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const withDemo = process.argv.includes('--demo');

// Dados de demonstração: identificados como tal e carregados somente com --demo.
const DEMO_MENU = [
  { cat: 'Tacos', items: [
    { name: 'Tacos de carne asada', description: 'Carne grelhada, cebola roxa em conserva e coentro fresco.', ingredients: 'Carne asada, tortilla de milho, cebola roxa, coentro, limão', priceCents: 1890, prepMinutes: 15, popularity: 9, addons: [['Extra carne', 900], ['Guacamole', 600], ['Extra queijo', 400]] },
    { name: 'Tacos de frango al pastor', description: 'Frango marinado com abacaxi, pimenta e molho verde.', ingredients: 'Frango, abacaxi, achiote, tortilla de milho, coentro', priceCents: 1690, prepMinutes: 15, popularity: 7, addons: [['Extra frango', 900], ['Guacamole', 600]] },
  ]},
  { cat: 'Burritos', items: [
    { name: 'Burrito Coyote', description: 'Tortilla de trigo com arroz, feijão, queijo e molho da casa.', ingredients: 'Arroz, feijão, queijo, tortilla de trigo, pico de gallo', priceCents: 2890, prepMinutes: 20, popularity: 8, addons: [['Extra queijo', 400], ['Sour cream', 500], ['Guacamole', 600]] },
  ]},
  { cat: 'Nachos', items: [
    { name: 'Nachos supremos', description: 'Totopos com queijo derretido, guacamole e pico de gallo.', ingredients: 'Totopos de milho, queijo cheddar, guacamole, jalapeño', priceCents: 3290, prepMinutes: 12, popularity: 6, addons: [['Extra queijo', 500], ['Jalapeño', 300]] },
  ]},
  { cat: 'Bebidas', items: [
    { name: 'Limonada mexicana', description: 'Limão siciliano, hortelã e um toque de sal.', ingredients: 'Limão, água, açúcar, hortelã, sal', priceCents: 990, prepMinutes: 3, popularity: 6, addons: [] },
  ]},
];

async function seedDemo() {
  if (await prisma.product.count()) {
    console.log('Já existem produtos no banco. Demonstração ignorada.');
    return;
  }
  let order = 0;
  for (const c of DEMO_MENU) {
    const category = await prisma.category.create({ data: { name: c.cat, sortOrder: order++ } });
    for (const it of c.items) {
      const { addons, ...data } = it;
      await prisma.product.create({
        data: { ...data, categoryId: category.id, addons: { create: addons.map(([name, priceCents]) => ({ name, priceCents })) } },
      });
    }
  }
  console.log('Dados de demonstração carregados (substitua pelo cardápio real).');
}

async function main() {
  await prisma.restaurantSettings.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default' } });

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 12) throw new Error('ADMIN_PASSWORD precisa ter pelo menos 12 caracteres');
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      await prisma.user.update({ where: { email }, data: { role: 'OWNER', active: true } });
      console.log('Usuário existente promovido a OWNER (senha não alterada):', email);
    } else {
      await prisma.user.create({
        data: { email, name: 'Proprietário', passwordHash: await bcrypt.hash(password, 12), role: 'OWNER' },
      });
      console.log('Proprietário criado:', email);
    }
  } else {
    console.log('ADMIN_EMAIL e ADMIN_PASSWORD não definidos: nenhum administrador criado.');
  }

  if (withDemo) await seedDemo();
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
