export class Product {
    constructor(
        public readonly id: number,
        public readonly name: string,
        public readonly description: string,
        public readonly price: number,
        public readonly imageUrl?: string,
    ) {}
}

export class CreateProductDto {
    constructor(
        public readonly name: string,
        public readonly description: string,
        public readonly price: number,
        public readonly imageUrl?: string,
    ) {}
}

export class UpdateProductDto {
    constructor(
        public readonly id: number,
        public readonly name: string,
        public readonly description: string,
        public readonly price: number,
        public readonly imageUrl?: string,
    ) {}
}

export class PatchProductDto {
    constructor(
        public readonly id: number,
        public readonly name?: string,
        public readonly description?: string,
        public readonly price?: number,
        public readonly imageUrl?: string,
    ) {}
}

export class DeleteProductDto {
    constructor(
        public readonly id: number,
    ) {}
}

export class GetProductByIdDto {
    constructor(
        public readonly id: number,
    ) {}
}