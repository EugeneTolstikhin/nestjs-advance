import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn
} from 'typeorm';

@Entity({ name: 'products' })
export class Products {
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

    @Column({ type: 'text', nullable: true })
    imageUrl?: string | null;

    @CreateDateColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
    updatedAt: Date;
}
