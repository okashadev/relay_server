export const encodeCursor = (createdAt: Date, id: string) =>
  `${createdAt.toISOString()}_${id}`;

export const decodeCursor = (
  cursor: string,
): { createdAt: Date; id: string } | null => {
  const [iso, id] = cursor.split("_");
  const createdAt = new Date(iso);

  if (!id || Number.isNaN(createdAt.getTime())) return null;

  return { createdAt, id };
};