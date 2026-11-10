import {
    Check,
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn
} from 'typeorm';

@Entity({ name: 'products' })
@Check('CHK_products_stock', "typeof(stock) = 'integer' AND stock >= 0 AND stock <= 2147483647")
export class Products {
    // Response-only availability; physical stock remains unchanged by reservations.
    availableStock?: number;

    // Response-only ordered media; metadata is persisted in product_media.
    media?: { id: string; kind: string; isVideo: boolean; name: string; size: number; position: number; url: string; poster?: string; width: number; height: number; duration: number }[];

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({
        unique: true,
        nullable: false,
        length: 100
    })
    name: string;

    @Column({
        nullable: false,
        length: 255
    })
    description: string;

    @Column('decimal', { 
        precision: 10,
        scale: 2,
        nullable: false
    })
    price: number;

    @Column('integer', { default: 0 })
    stock: number;

    @CreateDateColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
    updatedAt: Date;

    // NULL is reserved for legacy products awaiting explicit ownership assignment.
    @Index('IDX_products_sellerId')
    @Column('uuid', { nullable: true })
    sellerId: string | null;
}
