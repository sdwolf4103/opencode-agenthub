export type ModelSelection = {
	model?: string;
	variant?: string;
};

const normalizeOptionalString = (value?: string | null): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

export const parseModelString = (value?: string | null): ModelSelection => {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return {};
	const match = trimmed.match(/^(\S+)\s+(.+)$/);
	if (!match) {
		return { model: trimmed };
	}
	const variant = normalizeOptionalString(match[2]);
	return {
		model: match[1],
		...(variant ? { variant } : {}),
	};
};

export const normalizeModelSelection = (
	model?: string | null,
	variant?: string | null,
): ModelSelection => {
	const parsed = parseModelString(model);
	const explicitVariant = normalizeOptionalString(variant);
	return {
		...(parsed.model ? { model: parsed.model } : {}),
		...(explicitVariant || parsed.variant
			? { variant: explicitVariant || parsed.variant }
			: {}),
	};
};

export const pickModelSelection = (
	...sources: Array<ModelSelection | undefined>
): ModelSelection => {
	const model = sources
		.map((source) => source?.model)
		.find((value): value is string => typeof value === "string" && value.length > 0);
	const variant = sources
		.map((source) => source?.variant)
		.find((value): value is string => typeof value === "string" && value.length > 0);
	return {
		...(model ? { model } : {}),
		...(model && variant ? { variant } : {}),
	};
};
