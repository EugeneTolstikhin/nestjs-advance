import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn
} from 'typeorm';

@Entity({ name: 'products' })
export class Products {
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

    @CreateDateColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
    updatedAt: Date;
}
