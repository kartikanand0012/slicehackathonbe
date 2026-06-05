import { prisma } from "@/db/prisma";
import { NotFoundError } from "@/lib/errors";
import type {
  CreateContactBody,
  ListContactsQuery,
  UpdateContactBody,
} from "./contacts.schemas";

const CONTACT_PUBLIC_SELECT = {
  id: true,
  displayName: true,
  phone: true,
  email: true,
  linkedUserId: true,
  createdAt: true,
  updatedAt: true,
  linkedUser: {
    select: { id: true, name: true, avatarUrl: true, upiHandle: true },
  },
} as const;

async function findPlatformUserByPhoneOrEmail(
  phone: string | null | undefined,
  email: string | null | undefined,
): Promise<string | null> {
  if (!phone && !email) return null;
  const u = await prisma.user.findFirst({
    where: {
      OR: [
        ...(phone ? [{ phone }] : []),
        ...(email ? [{ email }] : []),
      ],
    },
    select: { id: true },
  });
  return u?.id ?? null;
}

export async function listContacts(ownerId: string, query: ListContactsQuery) {
  const items = await prisma.contact.findMany({
    where: {
      ownerId,
      ...(query.search
        ? {
            OR: [
              { displayName: { contains: query.search, mode: "insensitive" } },
              { phone: { contains: query.search } },
              { email: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: CONTACT_PUBLIC_SELECT,
    orderBy: { displayName: "asc" },
    take: query.limit,
  });
  return { items };
}

export async function createContact(
  ownerId: string,
  body: CreateContactBody,
) {
  const linkedUserId = await findPlatformUserByPhoneOrEmail(
    body.phone,
    body.email,
  );
  const contact = await prisma.contact.create({
    data: {
      ownerId,
      displayName: body.displayName,
      phone: body.phone ?? null,
      email: body.email ?? null,
      linkedUserId,
    },
    select: CONTACT_PUBLIC_SELECT,
  });
  return contact;
}

export async function updateContact(
  ownerId: string,
  contactId: string,
  body: UpdateContactBody,
) {
  const existing = await prisma.contact.findFirst({
    where: { id: contactId, ownerId },
    select: { id: true, phone: true, email: true },
  });
  if (!existing) throw new NotFoundError("Contact not found");

  // Re-resolve linkedUserId if phone or email changed.
  const newPhone = body.phone === undefined ? existing.phone : body.phone;
  const newEmail = body.email === undefined ? existing.email : body.email;
  const linkedUserId =
    body.phone !== undefined || body.email !== undefined
      ? await findPlatformUserByPhoneOrEmail(newPhone, newEmail)
      : undefined;

  const contact = await prisma.contact.update({
    where: { id: contactId },
    data: {
      displayName: body.displayName,
      phone: body.phone,
      email: body.email,
      ...(linkedUserId !== undefined ? { linkedUserId } : {}),
    },
    select: CONTACT_PUBLIC_SELECT,
  });
  return contact;
}

export async function deleteContact(ownerId: string, contactId: string) {
  const found = await prisma.contact.findFirst({
    where: { id: contactId, ownerId },
    select: { id: true },
  });
  if (!found) throw new NotFoundError("Contact not found");
  await prisma.contact.delete({ where: { id: contactId } });
}
